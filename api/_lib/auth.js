// Autenticacion: contraseña con scrypt y una sesion por dispositivo.
// El token viaja en el header `x-session-token`; en la base solo queda su sha256.

import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

const KEYLEN = 32;

// "salt:hash": la contraseña nunca se guarda en claro.
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  let calc;
  try {
    calc = crypto.scryptSync(String(pw), salt, KEYLEN).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(calc, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Abre una sesion nueva y devuelve el token (lo unico que ve el cliente).
export async function openSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = nowIso();
  await db.execute({
    sql: 'INSERT INTO sessions (tokenHash, userId, createdAt, lastSeenAt) VALUES (?, ?, ?, ?)',
    args: [sha256(token), userId, now, now],
  });
  return token;
}

const tokenFromReq = (req) => (req.headers?.['x-session-token'] || '').toString();

export async function closeSession(req) {
  const token = tokenFromReq(req);
  if (token) await db.execute({ sql: 'DELETE FROM sessions WHERE tokenHash = ?', args: [sha256(token)] });
}

// Cierra todas las sesiones de alguien menos, si se indica, la de esta peticion.
// Se usa al cambiar la contraseña: quien la robo pierde el acceso.
export async function closeOtherSessions(userId, req) {
  const keep = tokenFromReq(req);
  await db.execute({
    sql: 'DELETE FROM sessions WHERE userId = ? AND tokenHash <> ?',
    args: [userId, keep ? sha256(keep) : ''],
  });
}

// La puerta de entrada de todos los endpoints:
//   const me = await currentUser(req); if (!me) return deny(res);
export async function currentUser(req) {
  const token = tokenFromReq(req);
  if (token.length < 16) return null;
  const hash = sha256(token);
  const rs = await db.execute({
    sql: `SELECT u.id, u.name, u.fullName, u.email, s.lastSeenAt FROM sessions s
            JOIN users u ON u.id = s.userId WHERE s.tokenHash = ? LIMIT 1`,
    args: [hash],
  });
  const u = rs.rows[0];
  if (!u) return null;
  // Marcar actividad cuesta una escritura: una vez por hora basta.
  if (Date.now() - new Date(u.lastSeenAt).getTime() > 3600_000) {
    await db.execute({ sql: 'UPDATE sessions SET lastSeenAt = ? WHERE tokenHash = ?', args: [nowIso(), hash] });
  }
  return { id: Number(u.id), name: u.name, fullName: u.fullName, email: u.email };
}

export const deny = (res) => res.status(401).json({ error: 'Sesión inválida. Vuelve a entrar.' });

// 404 y no 403 a proposito: quien no tiene acceso a una visita tampoco deberia
// poder deducir que existe.
export const notYours = (res) => res.status(404).json({ error: 'No encontrado.' });
