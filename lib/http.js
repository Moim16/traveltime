// Utilidades comunes de las funciones serverless.

// Lee y parsea el body JSON, tolerando que Vercel ya lo haya parseado (objeto)
// o no (stream sin procesar, como en scripts/dev.mjs).
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  if (typeof req?.[Symbol.asyncIterator] !== 'function') return {};
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Texto de una linea, limpio y acotado; null si queda vacio (para guardar NULL).
export function clean(v, max = 120) {
  const s = (v ?? '').toString().trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
}

// Texto largo: conserva los saltos de linea, que en un relato son parrafos.
export function cleanText(v, max = 20000) {
  const s = (v ?? '')
    .toString()
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s ? s.slice(0, max) : null;
}

// Fecha YYYY-MM-DD real (rechaza 2026-02-31).
export function parseDay(v) {
  const s = (v ?? '').toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? s : null;
}

export function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Id de un lugar del mapa: "NIC", "NIC.granada", "NIC.granada.granada".
// El servidor no tiene los mapas (son estaticos), asi que solo valida la forma.
const PLACE_RE = /^[A-Z]{3}(\.[a-z0-9-]{1,80}){0,2}$/;
export const parsePlace = (v) => {
  const s = (v ?? '').toString().trim();
  return PLACE_RE.test(s) ? s : null;
};
