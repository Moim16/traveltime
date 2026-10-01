// Cloudflare Images: subida directa desde el telefono y entrega con URL firmada.
//
// La foto NO pasa por la funcion de Vercel (limite de 4.5 MB por peticion): el
// servidor pide a Cloudflare una URL de un solo uso y el telefono sube ahi.
// Todas se suben con requireSignedURLs: sin una firma vigente, la URL de una
// foto no sirve aunque alguien la copie.

import crypto from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4/accounts';
const env = () => ({
  acc: process.env.CF_ACCOUNT_ID,
  hash: process.env.CF_ACCOUNT_HASH,
  token: process.env.CF_IMAGES_TOKEN,
  key: process.env.CF_IMAGES_SIGNING_KEY,
});

export const imagesReady = () => {
  const e = env();
  return Boolean(e.acc && e.hash && e.token && e.key);
};

// Cuanto vive un enlace a una foto. Suficiente para mirar una visita con calma;
// si alguien lo copia, a las pocas horas ya no sirve.
export const URL_TTL_S = 4 * 3600;

export const VARIANTS = ['ttthumb', 'ttcard', 'ttfull'];

async function cf(method, path, body) {
  const { acc, token } = env();
  const r = await fetch(`${API}/${acc}/images${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    const err = new Error(`cloudflare ${r.status}: ${(j.errors || []).map((e) => e.message).join('; ')}`);
    err.status = r.status;
    throw err;
  }
  return j.result;
}

// URL de un solo uso para que el navegador suba UNA foto. Vence a los 30 minutos.
// meta queda guardada en Cloudflare: sirve para saber de quien es cada imagen
// si un dia hay que limpiar a mano.
export async function directUpload(meta) {
  const form = new FormData();
  form.set('requireSignedURLs', 'true');
  form.set('metadata', JSON.stringify(meta));
  form.set('expiry', new Date(Date.now() + 30 * 60 * 1000).toISOString());
  const r = await cf('POST', '/v2/direct_upload', form);
  return { cfId: r.id, uploadURL: r.uploadURL };
}

// true si la foto ya se subio (mientras no, Cloudflare la tiene como borrador).
export async function isUploaded(cfId) {
  try {
    const r = await cf('GET', `/v1/${encodeURIComponent(cfId)}`);
    return !r.draft;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

export async function deleteImage(cfId) {
  try {
    await cf('DELETE', `/v1/${encodeURIComponent(cfId)}`);
  } catch (e) {
    if (e.status !== 404) throw e; // ya no estaba: da igual
  }
}

// https://imagedelivery.net/<hash>/<id>/<variante>?exp=...&sig=...
// La firma es HMAC-SHA256 de "ruta?exp=..." con la clave de la cuenta.
export function signedUrl(cfId, variant, now = Date.now()) {
  const { hash, key } = env();
  const exp = Math.floor(now / 1000) + URL_TTL_S;
  const path = `/${hash}/${cfId}/${variant}`;
  const toSign = `${path}?exp=${exp}`;
  const sig = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `https://imagedelivery.net${toSign}&sig=${sig}`;
}
