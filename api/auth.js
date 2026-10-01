// Cuentas.
//
//  GET    /api/auth                 -> { me, recovery }
//  POST   /api/auth                 { name, password } -> login. { user, token }
//  POST   /api/auth?signup=1        { name, password, fullName, email } -> manda un
//                                   codigo al correo y NO crea nada. { pending, email }.
//                                   Sin correo configurado crea la cuenta de una.
//  POST   /api/auth?verify=1        { email, code } -> confirma y crea la cuenta.
//                                   { user, token, recovery }
//  POST   /api/auth?recover=1       { name, code, password } -> entrar con el codigo
//                                   de recuperacion y poner contraseña nueva.
//  POST   /api/auth?logout=1        -> cierra la sesion de este dispositivo.
//  PUT    /api/auth?password=1      { currentPassword, password } -> cambia la
//                                   contraseña y cierra las otras sesiones.
//  PUT    /api/auth?recovery=1      { currentPassword } -> codigo de recuperacion nuevo.
//
// Anti fuerza bruta: 5 fallos -> 15 minutos bloqueado. El codigo de recuperacion
// comparte el contador con la contraseña.
//
// CODIGO DE RECUPERACION: se entrega al crear la cuenta, se muestra UNA vez y se
// guarda hasheado. Es de un solo uso y al usarlo se entrega otro. Sirve aunque
// no haya correo configurado.

import { db, ensureSchema, nowIso, newRecoveryCode, normalizeRecovery } from '../lib/db.js';
import { readJson, clean } from '../lib/http.js';
import { mailReady, validEmail, cleanEmail, sendCode, newCode } from '../lib/mail.js';
import {
  hashPassword, verifyPassword, openSession, closeSession, closeOtherSessions, currentUser, deny,
} from '../lib/auth.js';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
const NAME_RE = /^[\p{L}\p{N}._-]{2,20}$/u;
const SIGNUP_OPEN = process.env.ALLOW_SIGNUP !== '0';

// Que esta mal en el usuario, dicho en concreto: un "usuario invalido" generico
// no ayuda cuando el navegador autocompleto el campo con un correo y uno no lo nota.
function nameProblem(name) {
  if (!name) return 'Escribe un nombre de usuario.';
  if (/\s/.test(name)) return 'El usuario no puede tener espacios.';
  const bad = [...new Set(name.match(/[^\p{L}\p{N}._-]/gu) ?? [])];
  if (bad.length) {
    return `El usuario no puede llevar ${bad.map((c) => `«${c}»`).join(' ')}${bad.includes('@') ? ' (¿se autocompletó con tu correo?)' : ''}. Usa letras, números, punto, guion o guion bajo.`;
  }
  if (name.length < 2) return 'El usuario debe tener al menos 2 caracteres.';
  if (name.length > 20) return `El usuario puede tener hasta 20 caracteres (tiene ${name.length}).`;
  return null;
}
const PW_MSG = 'La contraseña debe tener entre 8 y 64 caracteres.';
const badPassword = (pw) => pw.length < 8 || pw.length > 64;

const publicUser = (u) => ({ id: Number(u.id), name: u.name, fullName: u.fullName ?? null, email: u.email ?? null });
const isLocked = (u) => u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();

async function registerFail(u) {
  const fails = Number(u.failedLogins || 0) + 1;
  const locked = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
  await db.execute({ sql: 'UPDATE users SET failedLogins = ?, lockedUntil = ? WHERE id = ?', args: [fails, locked, u.id] });
}

const nameTaken = async (name) =>
  (await db.execute({ sql: 'SELECT 1 FROM users WHERE name = ? COLLATE NOCASE', args: [name] })).rows.length > 0;

// Crea el usuario y responde con la sesion abierta y su codigo de recuperacion.
async function createUser(res, { name, fullName, email, passwordHash }) {
  const now = nowIso();
  const code = newRecoveryCode();
  const ins = await db.execute({
    sql: `INSERT INTO users (name, fullName, email, passwordHash, recoveryHash, recoveryAt, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [name, fullName, email, passwordHash, hashPassword(normalizeRecovery(code)), now, now],
  });
  const id = Number(ins.lastInsertRowid);
  const token = await openSession(id);
  return res.status(201).json({ user: publicUser({ id, name, fullName, email }), token, recovery: code });
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const q = req.query ?? {};
    const body = req.method === 'GET' ? {} : await readJson(req);

    if (req.method === 'GET') {
      const me = await currentUser(req);
      if (!me) return deny(res);
      const rs = await db.execute({ sql: 'SELECT recoveryAt FROM users WHERE id = ?', args: [me.id] });
      return res.status(200).json({ me, recovery: { at: rs.rows[0]?.recoveryAt ?? null } });
    }

    if (req.method === 'POST' && q.signup) {
      if (!SIGNUP_OPEN) return res.status(403).json({ error: 'El registro está cerrado.' });
      const name = (body.name ?? '').toString().trim();
      const pw = (body.password ?? '').toString();
      const fullName = clean(body.fullName, 80);
      const email = cleanEmail(body.email);
      const problem = nameProblem(name);
      if (problem) return res.status(400).json({ error: problem });
      if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
      if (await nameTaken(name)) return res.status(409).json({ error: 'Ese usuario ya existe. Elige otro.' });

      // Pedir un codigo que no se puede enviar dejaria la app sin forma de arrancar.
      if (!mailReady()) {
        return createUser(res, { name, fullName, email: validEmail(email) ? email : null, passwordHash: hashPassword(pw) });
      }

      if (!validEmail(email)) return res.status(400).json({ error: 'Escribe un correo válido.' });
      const dupMail = await db.execute({ sql: 'SELECT 1 FROM users WHERE email = ? COLLATE NOCASE', args: [email] });
      if (dupMail.rows.length) return res.status(409).json({ error: 'Ya hay una cuenta con ese correo.' });

      const code = newCode();
      await db.execute({
        sql: `INSERT INTO signups (email, name, fullName, passwordHash, codeHash, tries, expiresAt, createdAt)
              VALUES (?, ?, ?, ?, ?, 0, ?, ?)
              ON CONFLICT(email) DO UPDATE SET
                name = excluded.name, fullName = excluded.fullName, passwordHash = excluded.passwordHash,
                codeHash = excluded.codeHash, tries = 0, expiresAt = excluded.expiresAt`,
        args: [email, name, fullName, hashPassword(pw), hashPassword(code), new Date(Date.now() + CODE_TTL_MS).toISOString(), nowIso()],
      });
      const sent = await sendCode(email, code);
      if (!sent.ok) {
        // Un registro pendiente cuyo correo no salio solo reservaria el usuario.
        await db.execute({ sql: 'DELETE FROM signups WHERE email = ?', args: [email] });
        return res.status(502).json({ error: sent.error });
      }
      return res.status(200).json({ pending: true, email });
    }

    if (req.method === 'POST' && q.verify) {
      const email = cleanEmail(body.email);
      const code = (body.code ?? '').toString().replace(/\D/g, '');
      const p = (await db.execute({ sql: 'SELECT * FROM signups WHERE email = ?', args: [email] })).rows[0];
      const drop = () => db.execute({ sql: 'DELETE FROM signups WHERE email = ?', args: [email] });
      if (!p) return res.status(404).json({ error: 'No hay ningún registro para ese correo. Empieza de nuevo.' });
      if (p.expiresAt < nowIso()) {
        await drop();
        return res.status(410).json({ error: 'El código venció. Pide uno nuevo.' });
      }
      // Sin tope, seis digitos se prueban a mano.
      if (Number(p.tries) >= MAX_FAILS) {
        await drop();
        return res.status(429).json({ error: 'Demasiados intentos. Pide un código nuevo.' });
      }
      if (!verifyPassword(code, p.codeHash)) {
        await db.execute({ sql: 'UPDATE signups SET tries = tries + 1 WHERE email = ?', args: [email] });
        return res.status(401).json({ error: 'El código no es correcto.' });
      }
      await drop();
      // Entre pedir el codigo y confirmarlo alguien pudo tomar el usuario.
      if (await nameTaken(p.name)) return res.status(409).json({ error: 'Ese usuario ya existe. Empieza de nuevo con otro.' });
      return createUser(res, { name: p.name, fullName: p.fullName, email, passwordHash: p.passwordHash });
    }

    if (req.method === 'POST' && q.recover) {
      const name = (body.name ?? '').toString().trim();
      const code = normalizeRecovery(body.code);
      const pw = (body.password ?? '').toString();
      if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
      const u = (await db.execute({ sql: 'SELECT * FROM users WHERE name = ? COLLATE NOCASE', args: [name] })).rows[0];
      // El mismo texto exista o no el usuario: por aqui no se averigua quien tiene cuenta.
      const bad = () => res.status(401).json({ error: 'Usuario o código incorrectos.' });
      if (!u) return bad();
      if (isLocked(u)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      if (!u.recoveryHash || !verifyPassword(code, u.recoveryHash)) {
        await registerFail(u);
        return bad();
      }
      // De un solo uso: se entrega otro en el acto, y se cierran todas las
      // sesiones (si alguien entro con la contraseña vieja, queda afuera).
      const next = newRecoveryCode();
      await db.execute({
        sql: `UPDATE users SET passwordHash = ?, failedLogins = 0, lockedUntil = NULL, recoveryHash = ?, recoveryAt = ? WHERE id = ?`,
        args: [hashPassword(pw), hashPassword(normalizeRecovery(next)), nowIso(), u.id],
      });
      await db.execute({ sql: 'DELETE FROM sessions WHERE userId = ?', args: [u.id] });
      const token = await openSession(Number(u.id));
      return res.status(200).json({ user: publicUser(u), token, recovery: next });
    }

    if (req.method === 'POST' && q.logout) {
      await closeSession(req);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      const name = (body.name ?? '').toString().trim();
      const pw = (body.password ?? '').toString();
      const bad = () => res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      if (!NAME_RE.test(name) || !pw) return bad();
      const u = (await db.execute({ sql: 'SELECT * FROM users WHERE name = ? COLLATE NOCASE', args: [name] })).rows[0];
      if (!u) return bad();
      if (isLocked(u)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      if (!verifyPassword(pw, u.passwordHash)) {
        await registerFail(u);
        return bad();
      }
      await db.execute({ sql: 'UPDATE users SET failedLogins = 0, lockedUntil = NULL WHERE id = ?', args: [u.id] });
      return res.status(200).json({ user: publicUser(u), token: await openSession(Number(u.id)) });
    }

    if (req.method === 'PUT' && (q.password || q.recovery)) {
      const me = await currentUser(req);
      if (!me) return deny(res);
      // Con el telefono desbloqueado en la mano, cambiar la contraseña o sacar un
      // codigo nuevo seria quedarse con la cuenta: se pide la actual.
      const rs = await db.execute({ sql: 'SELECT passwordHash FROM users WHERE id = ?', args: [me.id] });
      if (!verifyPassword((body.currentPassword ?? '').toString(), rs.rows[0]?.passwordHash)) {
        return res.status(401).json({ error: 'La contraseña actual no coincide.' });
      }
      if (q.recovery) {
        const code = newRecoveryCode();
        await db.execute({
          sql: 'UPDATE users SET recoveryHash = ?, recoveryAt = ? WHERE id = ?',
          args: [hashPassword(normalizeRecovery(code)), nowIso(), me.id],
        });
        return res.status(200).json({ ok: true, recovery: code });
      }
      const pw = (body.password ?? '').toString();
      if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
      await db.execute({ sql: 'UPDATE users SET passwordHash = ? WHERE id = ?', args: [hashPassword(pw), me.id] });
      await closeOtherSessions(me.id, req);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/auth]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
