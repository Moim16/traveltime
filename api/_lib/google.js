// Verificar el "ID token" de "Entrar con Google" (Google Identity Services).
//
// El navegador recibe de Google un JWT firmado (RS256) y lo manda aqui. Se
// comprueba la firma con las claves publicas de Google (JWKS), que sea para
// esta app (aud = GOOGLE_CLIENT_ID), que lo emitio Google, que no vencio y que
// Google verifico el correo. Sin secreto de cliente: el ID token basta.

import crypto from 'node:crypto';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const SKEW_S = 60; // tolerancia de reloj

export const googleClientId = () => process.env.GOOGLE_CLIENT_ID || null;

// Las claves de Google rotan; se guardan lo que diga su Cache-Control.
let jwks = { keys: new Map(), until: 0 };
async function keyFor(kid) {
  if (Date.now() > jwks.until || !jwks.keys.has(kid)) {
    const r = await fetch(JWKS_URL);
    if (!r.ok) throw new Error(`google jwks ${r.status}`);
    const maxAge = Number((r.headers.get?.('cache-control') ?? '').match(/max-age=(\d+)/)?.[1] ?? 3600);
    const { keys } = await r.json();
    jwks = { keys: new Map(keys.map((k) => [k.kid, k])), until: Date.now() + maxAge * 1000 };
  }
  const jwk = jwks.keys.get(kid);
  return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// -> { sub, email, name, picture } o lanza Error con el motivo (para el log; al
// usuario se le dice algo generico).
export async function verifyGoogleToken(token, now = Date.now()) {
  const aud = googleClientId();
  if (!aud) throw new Error('GOOGLE_CLIENT_ID no esta configurado');
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new Error('token mal formado');
  const [h, p, s] = parts;
  const header = b64json(h);
  if (header.alg !== 'RS256') throw new Error(`alg ${header.alg}`);
  const key = await keyFor(header.kid);
  if (!key) throw new Error('kid desconocido');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('firma invalida');
  const c = b64json(p);
  const t = Math.floor(now / 1000);
  if (!ISSUERS.includes(c.iss)) throw new Error(`iss ${c.iss}`);
  if (c.aud !== aud) throw new Error('aud de otra app');
  if (!(c.exp > t - SKEW_S)) throw new Error('vencido');
  if (c.iat && c.iat > t + SKEW_S) throw new Error('emitido en el futuro');
  if (!c.sub) throw new Error('sin sub');
  if (!c.email || c.email_verified !== true) throw new Error('correo no verificado por Google');
  return { sub: String(c.sub), email: String(c.email).toLowerCase(), name: c.name ?? null, picture: c.picture ?? null };
}
