// Capa de datos (libSQL / SQLite).
//
//   - LOCAL (scripts/dev.mjs): archivo data/traveltime.db, sin cuenta ni setup.
//   - PRODUCCION (Vercel): Turso, con TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
//
// El esquema se crea solo la primera vez que se usa (CREATE TABLE IF NOT EXISTS
// y ALTER idempotentes): no hay migraciones.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const url = process.env.TURSO_DATABASE_URL || 'file:./data/traveltime.db';
const isRemote = !url.startsWith('file:');

// Remoto: el cliente web (JS puro sobre HTTP). El de binding nativo no se
// empaqueta bien en Vercel y tumba la funcion al cargar (pasó en deudas).
const { createClient } = await import(isRemote ? '@libsql/client/web' : '@libsql/client');

if (!isRemote) {
  try {
    mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  } catch {}
}

export const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

let schemaReady = null;
export function ensureSchema() {
  if (!schemaReady) schemaReady = initSchema();
  return schemaReady;
}

async function initSchema() {
  await db.execute('PRAGMA foreign_keys = ON');

  // Una persona, una cuenta. Lo que se comparte con otros se decide recuerdo por
  // recuerdo (fase 3), no con roles.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,              -- usuario para entrar
      fullName     TEXT,
      email        TEXT,                       -- NULL si se registro sin correo configurado
      passwordHash TEXT NOT NULL,
      failedLogins INTEGER NOT NULL DEFAULT 0,
      lockedUntil  TEXT,
      recoveryHash TEXT,                       -- codigo de recuperacion, hasheado
      recoveryAt   TEXT,
      createdAt    TEXT NOT NULL
    )`);
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users (name COLLATE NOCASE)');
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email COLLATE NOCASE) WHERE email IS NOT NULL');

  // Una sesion por dispositivo: entrar desde el telefono no cierra la del
  // computador (en deudas si, porque el token vivia en la fila del usuario).
  // Se guarda el sha256 del token: quien lea la base no puede entrar con el.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      tokenHash  TEXT PRIMARY KEY,
      userId     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      createdAt  TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL
    )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (userId)');

  // Registros a medias: los datos y el codigo mientras se confirma el correo.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS signups (
      email        TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      fullName     TEXT,
      passwordHash TEXT NOT NULL,
      codeHash     TEXT NOT NULL,
      tries        INTEGER NOT NULL DEFAULT 0,
      expiresAt    TEXT NOT NULL,
      createdAt    TEXT NOT NULL
    )`);

  // Lo que la persona marco como visitado. placeId es el id del mapa
  // ("NIC", "NIC.granada", "NIC.granada.granada"). Que un departamento o un pais
  // esten visitados se deduce por prefijo; no se guarda.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS marks (
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      placeId   TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (userId, placeId)
    )`);

  // Una visita a un lugar: ir a Granada en 2019 y en 2025 son dos filas.
  // body es texto simple por ahora; con el editor por bloques (fase 2) pasa a
  // JSON, nunca HTML.
  // privacy: 'private' es lo unico que existe hasta la fase 3.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS visits (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      placeId   TEXT NOT NULL,
      title     TEXT NOT NULL,
      startDay  TEXT,
      endDay    TEXT,
      body      TEXT,
      privacy   TEXT NOT NULL DEFAULT 'private',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_visits_user_place ON visits (userId, placeId)');
  // El nombre del lugar tal como se veia al crear la visita ("Granada, Granada,
  // Nicaragua"). La lista de visitas de un pais lo necesita, y sacarlo de los
  // mapas obligaria a bajar los de todos sus departamentos.
  try {
    await db.execute('ALTER TABLE visits ADD COLUMN placeName TEXT');
  } catch {
    /* ya existe */
  }

  // Las fotos de una visita. La imagen vive en Cloudflare (cfId); aqui solo lo
  // que hace falta para listarla y ordenarla.
  // status: 'pending' mientras el telefono la sube, 'ready' cuando ya esta.
  // takenAt/lat/lng salen del EXIF, leido en el telefono ANTES de subir:
  // Cloudflare entrega la foto sin metadatos, y el GPS se queda aqui, bajo control.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS photos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visitId   INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
      cfId      TEXT NOT NULL UNIQUE,
      status    TEXT NOT NULL DEFAULT 'pending',
      width     INTEGER,
      height    INTEGER,
      takenAt   TEXT,
      lat       REAL,
      lng       REAL,
      caption   TEXT,
      position  INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_photos_visit ON photos (visitId, position)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_photos_user ON photos (userId, status)');

  // Lugares puntuales de una visita: el convento, el restaurante, el mirador.
  // Cuelgan de la visita y no del municipio: "donde comi en Granada en 2019" es
  // parte de esa visita, y si vuelvo en 2025 puede ser otro lugar.
  // kind: ver PIN_KINDS.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pins (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visitId   INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'other',
      lat       REAL NOT NULL,
      lng       REAL NOT NULL,
      note      TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_pins_visit ON pins (visitId)');
}

// Alfabeto sin caracteres que se confundan (nada de I, O, 0, 1).
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Codigo de recuperacion: 12 caracteres en grupos de cuatro, para copiarlo de
// un papel sin equivocarse. 32^12 = 60 bits: no se adivina.
export function newRecoveryCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// Como se guarda y se compara: sin guiones, en mayusculas.
export const normalizeRecovery = (v) => (v ?? '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');

export const nowIso = () => new Date().toISOString();

// Tipos de lugar. Los mismos (con su nombre y color) estan en js/pins.js.
export const PIN_KINDS = ['see', 'eat', 'sleep', 'do', 'other'];
