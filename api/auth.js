// Cuentas.
//
//  GET    /api/auth                 -> { me, recovery }
//  GET    /api/auth?config=1        -> { googleClientId, passwordSignup, legacyLogin } (sin sesion)
//  POST   /api/auth?google=1        { credential } -> entrar (o crear la cuenta) con Google.
//                                   Con sesion y &link=1: conectar Google a MI cuenta.
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
//  PUT    /api/auth?profile=1       { fullName?, avatar?, bio?, livesIn?, languages?, interests?, dream? }
//                                   -> nombre, avatar (api/_lib/avatar.js) y "Sobre mi"
//                                   (api/_lib/profile.js). { me }
//  POST   /api/auth?avatarUpload=1  -> { cfId, uploadURL } para subir la foto de perfil;
//                                   despues PUT profile con avatar { kind: 'photo', cfId }.
//
// SOLO GOOGLE: se entra con Google. El registro con contraseña esta cerrado
// (ALLOW_PASSWORD_SIGNUP=1 lo abre: lo usan las pruebas) y la contraseña solo
// sirve en cuentas que todavia no conectaron Google, para poder conectarla.
//
// Anti fuerza bruta: 5 fallos -> 15 minutos bloqueado. El codigo de recuperacion
// comparte el contador con la contraseña.
//
// CODIGO DE RECUPERACION: se entrega al crear la cuenta, se muestra UNA vez y se
// guarda hasheado. Es de un solo uso y al usarlo se entrega otro. Sirve aunque
// no haya correo configurado.
//
// GOOGLE: el navegador manda el ID token que le dio Google y aqui se verifica
// (api/_lib/google.js). Se busca por googleSub; si no, por correo, pero SOLO se
// une a una cuenta existente si su correo estaba verificado. Sin eso, alguien
// que se registro con un correo ajeno (sin confirmar) se quedaria con la cuenta
// del dueño de ese correo cuando este entrara con Google.

import { db, ensureSchema, nowIso, newRecoveryCode, normalizeRecovery } from './_lib/db.js';
import { readJson, clean } from './_lib/http.js';
import { mailReady, validEmail, cleanEmail, sendCode, newCode } from './_lib/mail.js';
import { googleClientId, verifyGoogleToken } from './_lib/google.js';
import { avatarOf, parseAvatar, avatarPhotoId, cleanGooglePicture } from './_lib/avatar.js';
import { aboutOf, parseAbout, myStats } from './_lib/profile.js';
import { imagesReady, directUpload, imageInfo, deleteImage } from './_lib/images.js';
import {
  hashPassword, verifyPassword, openSession, closeSession, closeOtherSessions, currentUser, deny,
} from './_lib/auth.js';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
const NAME_RE = /^[\p{L}\p{N}._-]{2,20}$/u;
const SIGNUP_OPEN = process.env.ALLOW_PASSWORD_SIGNUP === '1';

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

const publicUser = (u) => ({ id: Number(u.id), name: u.name, fullName: u.fullName ?? null, email: u.email ?? null, avatar: avatarOf(u) });
const isLocked = (u) => u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();

async function registerFail(u) {
  const fails = Number(u.failedLogins || 0) + 1;
  const locked = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
  await db.execute({ sql: 'UPDATE users SET failedLogins = ?, lockedUntil = ? WHERE id = ?', args: [fails, locked, u.id] });
}

const nameTaken = async (name) =>
  (await db.execute({ sql: 'SELECT 1 FROM users WHERE name = ? COLLATE NOCASE', args: [name] })).rows.length > 0;

// Crea el usuario y responde con la sesion abierta y su codigo de recuperacion.
// Con Google no hay contraseña (passwordHash vacio: ningun login por clave la
// acepta) ni codigo de recuperacion: se recupera entrando con Google.
async function createUser(res, { name, fullName, email, passwordHash, emailVerified = 0, googleSub = null, googlePicture = null }) {
  const now = nowIso();
  const code = googleSub ? null : newRecoveryCode();
  const ins = await db.execute({
    sql: `INSERT INTO users (name, fullName, email, passwordHash, recoveryHash, recoveryAt, emailVerified, googleSub, googlePicture, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [name, fullName, email, passwordHash, code ? hashPassword(normalizeRecovery(code)) : null, code ? now : null, emailVerified, googleSub, googlePicture, now],
  });
  const id = Number(ins.lastInsertRowid);
  const token = await openSession(id);
  return res.status(201).json({ user: publicUser({ id, name, fullName, email, googlePicture }), token, ...(code ? { recovery: code } : {}), created: true });
}

// Un usuario a partir del correo de Google: "moises.mejia@gmail.com" -> "moises.mejia";
// si esta tomado, moises.mejia2, moises.mejia3... Se puede cambiar despues.
async function nameFromEmail(email) {
  let base = email.split('@')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 16);
  if (base.length < 2) base = 'viajero';
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}${n}`;
    if (!(await nameTaken(name))) return name;
  }
}

// Lo que ve la persona de su propia cuenta (GET y despues de cambiar el perfil).
async function meResponse(me) {
  const u = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [me.id] })).rows[0];
  return {
    me: {
      ...publicUser(u),
      hasGoogle: Boolean(u.googleSub),
      hasPassword: Boolean(u.passwordHash),
      hasGooglePicture: Boolean(u.googlePicture),
      since: u.createdAt,
      about: aboutOf(u),
      stats: await myStats(Number(u.id)),
    },
    recovery: { at: u.recoveryAt ?? null },
  };
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const q = req.query ?? {};
    const body = req.method === 'GET' ? {} : await readJson(req);

    if (req.method === 'GET' && q.config) {
      // legacyLogin: queda alguna cuenta de antes (con contraseña, sin Google). Mientras
      // haya, la ventana de entrar ofrece la contraseña para poder conectar Google;
      // cuando ya no quede ninguna, desaparece sola.
      const legacy = await db.execute("SELECT 1 FROM users WHERE googleSub IS NULL AND passwordHash != '' LIMIT 1");
      return res.status(200).json({ googleClientId: googleClientId(), passwordSignup: SIGNUP_OPEN, legacyLogin: legacy.rows.length > 0 });
    }

    if (req.method === 'GET') {
      const me = await currentUser(req);
      if (!me) return deny(res);
      return res.status(200).json(await meResponse(me));
    }

    if (req.method === 'POST' && q.google) {
      let g;
      try {
        g = await verifyGoogleToken(body.credential);
      } catch (err) {
        console.warn('[api/auth] google rechazado:', err.message);
        return res.status(401).json({ error: 'Google no confirmó tu cuenta. Intenta de nuevo.' });
      }
      const bySub = (await db.execute({ sql: 'SELECT * FROM users WHERE googleSub = ?', args: [g.sub] })).rows[0];

      // Conectar Google a la cuenta con la que ya entre (con su contraseña).
      if (q.link) {
        const me = await currentUser(req);
        if (!me) return deny(res);
        if (bySub && Number(bySub.id) !== me.id) return res.status(409).json({ error: 'Esa cuenta de Google ya está conectada a otro usuario.' });
        // Si el correo de Google es el de mi cuenta, queda verificado.
        await db.execute({
          sql: 'UPDATE users SET googleSub = ?, googlePicture = ?, emailVerified = CASE WHEN email = ? COLLATE NOCASE THEN 1 ELSE emailVerified END WHERE id = ?',
          args: [g.sub, cleanGooglePicture(g.picture), g.email, me.id],
        });
        return res.status(200).json({ ok: true });
      }

      // La foto se trae en cada entrada: si la cambia en Google, aqui tambien.
      const picture = cleanGooglePicture(g.picture);
      if (bySub) {
        await db.execute({ sql: 'UPDATE users SET googlePicture = ? WHERE id = ?', args: [picture, bySub.id] });
        return res.status(200).json({ user: publicUser({ ...bySub, googlePicture: picture }), token: await openSession(Number(bySub.id)) });
      }

      const byEmail = (await db.execute({ sql: 'SELECT * FROM users WHERE email = ? COLLATE NOCASE', args: [g.email] })).rows[0];
      if (byEmail) {
        if (!Number(byEmail.emailVerified)) {
          return res.status(409).json({
            error: `Ya hay una cuenta con el correo ${g.email}. Entra con su usuario y contraseña, y desde "Tu cuenta" conecta Google.`,
          });
        }
        await db.execute({ sql: 'UPDATE users SET googleSub = ?, googlePicture = ? WHERE id = ?', args: [g.sub, picture, byEmail.id] });
        return res.status(200).json({ user: publicUser({ ...byEmail, googlePicture: picture }), token: await openSession(Number(byEmail.id)) });
      }

      // Cuenta nueva. Con Google el correo ya viene verificado: no hace falta
      // codigo ni dominio de correo, asi que esto queda abierto aunque el
      // registro con contraseña este cerrado (ALLOW_GOOGLE_SIGNUP=0 lo cierra).
      if (process.env.ALLOW_GOOGLE_SIGNUP === '0') return res.status(403).json({ error: 'El registro está cerrado.' });
      return createUser(res, {
        name: await nameFromEmail(g.email),
        fullName: clean(g.name, 80),
        email: g.email,
        passwordHash: '',
        emailVerified: 1,
        googleSub: g.sub,
        googlePicture: picture,
      });
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
      return createUser(res, { name: p.name, fullName: p.fullName, email, passwordHash: p.passwordHash, emailVerified: 1 });
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

    if (req.method === 'POST' && q.avatarUpload) {
      const me = await currentUser(req);
      if (!me) return deny(res);
      if (!imagesReady()) return res.status(503).json({ error: 'Las fotos no están configuradas.' });
      return res.status(200).json(await directUpload({ userId: me.id, kind: 'avatar' }));
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
      // Con Google conectado, la contraseña ya no abre: despues del chequeo, para no
      // contarle a cualquiera que usuarios existen.
      if (u.googleSub) return res.status(403).json({ error: 'Esta cuenta entra con Google. Usa el botón «Continuar con Google».' });
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

    if (req.method === 'PUT' && q.profile) {
      const me = await currentUser(req);
      if (!me) return deny(res);
      const u = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [me.id] })).rows[0];
      const sets = [];
      const args = [];
      if (body.fullName !== undefined) {
        const fullName = clean(body.fullName, 80);
        if (!fullName) return res.status(400).json({ error: 'Escribe tu nombre.' });
        sets.push('fullName = ?');
        args.push(fullName);
      }
      const about = parseAbout(body);
      if (about.error) return res.status(400).json({ error: about.error });
      for (const [col, v] of Object.entries(about.cols)) {
        sets.push(`${col} = ?`);
        args.push(v);
      }
      let dropPhoto = null;
      if (body.avatar !== undefined) {
        const a = parseAvatar(body.avatar, u);
        if (a.error) return res.status(400).json({ error: a.error });
        // La foto tiene que estar subida y ser de quien la pone: el id de una foto
        // ajena se ve en las URL firmadas de las visitas compartidas.
        if (a.cfId && a.value !== u.avatar) {
          const info = await imageInfo(a.cfId);
          if (!info?.uploaded || Number(info.meta.userId) !== me.id || info.meta.kind !== 'avatar') {
            return res.status(400).json({ error: 'La foto no terminó de subir. Intenta de nuevo.' });
          }
        }
        const old = avatarPhotoId(u.avatar);
        if (old && old !== a.cfId) dropPhoto = old;
        sets.push('avatar = ?');
        args.push(a.value);
      }
      if (sets.length) await db.execute({ sql: `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args: [...args, me.id] });
      if (dropPhoto) await deleteImage(dropPhoto).catch((e) => console.warn('[api/auth] avatar viejo:', e.message));
      return res.status(200).json(await meResponse(me));
    }

    res.setHeader('Allow', 'GET, POST, PUT');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/auth]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
