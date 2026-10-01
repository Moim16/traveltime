// Pruebas contra los handlers reales, sobre una base SQLite descartable
// (data/smoke.db, se borra al empezar). No necesita servidor ni red.
//
//   node scripts/smoke.mjs
//
// Lo que mas importa que pase: que nadie vea ni toque lo de otro.

import { rmSync } from 'node:fs';

rmSync('./data/smoke.db', { force: true });
process.env.TURSO_DATABASE_URL = 'file:./data/smoke.db';
delete process.env.RESEND_API_KEY; // el registro sin correo: crea la cuenta de una

// Cloudflare Images de mentira: nada sale a la red. `cf` guarda lo que paso.
Object.assign(process.env, {
  CF_ACCOUNT_ID: 'acc0000000000000000000000000000a',
  CF_ACCOUNT_HASH: 'hashDePrueba',
  CF_IMAGES_TOKEN: 'token-de-prueba',
  CF_IMAGES_SIGNING_KEY: 'clave-de-firma-de-prueba',
});
const cf = { next: 0, uploaded: new Set(), deleted: [], created: [] };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (result) => ({ status: 200, json: async () => ({ success: true, result }) });
  if (u.endsWith('/images/v2/direct_upload')) {
    const id = `cf-${++cf.next}`;
    cf.created.push({ id, meta: JSON.parse(opts.body.get('metadata')), signed: opts.body.get('requireSignedURLs') });
    return ok({ id, uploadURL: `https://upload.imagedelivery.net/${id}` });
  }
  const m = u.match(/\/images\/v1\/([^/?]+)$/);
  if (m && opts.method === 'GET') return ok({ id: m[1], draft: !cf.uploaded.has(m[1]) });
  if (m && opts.method === 'DELETE') {
    cf.deleted.push(m[1]);
    return ok({});
  }
  throw new Error(`fetch inesperado en la prueba: ${u}`);
};

const handlers = {
  auth: (await import('../api/auth.js')).default,
  marks: (await import('../api/marks.js')).default,
  visits: (await import('../api/visits.js')).default,
  photos: (await import('../api/photos.js')).default,
  pins: (await import('../api/pins.js')).default,
  public: (await import('../api/public.js')).default,
  wishes: (await import('../api/wishes.js')).default,
};
const { db } = await import('../api/_lib/db.js');
const crypto = await import('node:crypto');

async function call(name, method, { query = {}, body, token } = {}) {
  const req = { method, query, body: body ?? {}, headers: token ? { 'x-session-token': token } : {} };
  let status = 200;
  let data;
  const headers = {};
  const res = {
    status(c) { status = c; return res; },
    json(d) { data = d; return res; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
  };
  await handlers[name](req, res);
  return { status, data, headers };
}

let passed = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) passed++;
  else failures.push(`✗ ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`);
}

// ---------------------------------------------------------------- cuentas
const a = await call('auth', 'POST', { query: { signup: 1 }, body: { name: 'moises', password: 'viajero123', fullName: 'Moisés' } });
check('registro crea la cuenta', a.status === 201 && a.data.token && a.data.recovery, a);
const A = a.data.token;
const recoveryA = a.data.recovery;
check('el codigo de recuperacion tiene la forma XXXX-XXXX-XXXX', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(recoveryA));

check('usuario repetido (sin importar mayusculas)',
  (await call('auth', 'POST', { query: { signup: 1 }, body: { name: 'MOISES', password: 'otraclave1' } })).status === 409);
check('contraseña corta',
  (await call('auth', 'POST', { query: { signup: 1 }, body: { name: 'corto', password: '123' } })).status === 400);
check('usuario con espacios',
  (await call('auth', 'POST', { query: { signup: 1 }, body: { name: 'con espacio', password: 'viajero123' } })).status === 400);

const b = await call('auth', 'POST', { query: { signup: 1 }, body: { name: 'otra', password: 'viajera123' } });
const B = b.data.token;

const meA = await call('auth', 'GET', { token: A });
check('GET me devuelve al dueño del token', meA.data.me?.name === 'moises', meA);
check('sin token: 401', (await call('auth', 'GET')).status === 401);
check('token inventado: 401', (await call('auth', 'GET', { token: 'x'.repeat(64) })).status === 401);

const login = await call('auth', 'POST', { body: { name: 'Moises', password: 'viajero123' } });
check('login abre una sesion nueva', login.status === 200 && login.data.token && login.data.token !== A);
const A2 = login.data.token;
check('entrar en otro dispositivo no cierra la primera sesion', (await call('auth', 'GET', { token: A })).status === 200);

// ---------------------------------------------------------------- marcas
const m1 = await call('marks', 'PUT', { token: A, body: { placeId: 'NIC.granada.granada', on: true } });
check('marcar un municipio', m1.data.marks?.includes('NIC.granada.granada'), m1);
check('lugar con forma invalida', (await call('marks', 'PUT', { token: A, body: { placeId: '../etc', on: true } })).status === 400);
check('marcar sin sesion', (await call('marks', 'PUT', { body: { placeId: 'NIC', on: true } })).status === 401);
check('la otra persona no ve mis marcas', (await call('marks', 'GET', { token: B })).data.marks.length === 0);
await call('marks', 'PUT', { token: A, body: { placeId: 'NIC.granada.granada', on: false } });
check('desmarcar', (await call('marks', 'GET', { token: A })).data.marks.length === 0);

// ---------------------------------------------------------------- visitas
const v1 = await call('visits', 'POST', {
  token: A,
  body: { placeId: 'NIC.granada.granada', placeName: 'Granada, Granada, Nicaragua', title: 'Semana Santa', startDay: '2025-04-17', endDay: '2025-04-20', body: 'Las isletas.\r\n\r\n\r\nY el volcán.' },
});
check('crear visita', v1.status === 201 && v1.data.visit.id, v1);
const V1 = v1.data.visit.id;
check('un relato en texto (fase 1) se lee como parrafos',
  JSON.stringify(v1.data.visit.body?.blocks?.map((b) => b.data.text)) === JSON.stringify(['Las isletas.', 'Y el volcán.']), v1.data.visit.body);

// ---------------------------------------------------------------- relato por bloques
const { sanitizeInline, parseStory, excerpt } = await import('../api/_lib/story.js');
check('se quita una imagen con onerror', sanitizeInline('hola <img src=x onerror=alert(1)>mundo') === 'hola mundo', sanitizeInline('hola <img src=x onerror=alert(1)>mundo'));
check('se quita un script (queda solo el texto)', !/<script/i.test(sanitizeInline('<script>alert(1)</script>ok')));
check('un enlace javascript: pierde el enlace', sanitizeInline('<a href="javascript:alert(1)">clic</a>') === 'clic', sanitizeInline('<a href="javascript:alert(1)">clic</a>'));
check('un enlace https queda, sin atributos de mas',
  sanitizeInline('<a href="https://x.com/a?b=1&amp;c=2" onclick="robar()" style="x">sitio</a>') === '<a href="https://x.com/a?b=1&amp;c=2">sitio</a>',
  sanitizeInline('<a href="https://x.com/a?b=1&amp;c=2" onclick="robar()" style="x">sitio</a>'));
check('una comilla en el href no rompe el atributo', !/"[^"]*"[^>]*onerror/.test(sanitizeInline(`<a href='https://x.com/"onerror="alert(1)'>x</a>`)), sanitizeInline(`<a href='https://x.com/"onerror="alert(1)'>x</a>`));
check('negrita y cursiva quedan; strong pasa a b', sanitizeInline('<strong>a</strong> <i>b</i> <mark class="cdx-marker">c</mark>') === '<b>a</b> <i>b</i> <mark>c</mark>');
check('una etiqueta sin cerrar se cierra', sanitizeInline('<b>sin cerrar') === '<b>sin cerrar</b>');
check('un < suelto se escapa', sanitizeInline('3 < 5 y 7 > 2') === '3 &lt; 5 y 7 &gt; 2');

const doc = parseStory({
  blocks: [
    { type: 'header', data: { text: 'Día 1', level: 2 } },
    { type: 'paragraph', data: { text: 'Llegamos <b>temprano</b>.' } },
    { type: 'paragraph', data: { text: '' } },
    { type: 'iframe', data: { src: 'https://malo.com' } },
    { type: 'list', data: { style: 'checklist', items: [{ content: 'Bloqueador', meta: { checked: true }, items: [] }] } },
    { type: 'callout', data: { emoji: '💡', text: 'Llevar efectivo' } },
    { type: 'photo', data: { photoId: 7, caption: 'La <script>x</script>catedral' } },
    { type: 'photo', data: { photoId: 'abc' } },
    { type: 'place', data: { pinId: 3 } },
  ],
});
const blocks = JSON.parse(doc.value).blocks;
check('bloques: se descartan los desconocidos, los vacios y los ids malos',
  JSON.stringify(blocks.map((b) => b.type)) === JSON.stringify(['header', 'paragraph', 'list', 'callout', 'photo', 'place']), blocks.map((b) => b.type));
check('la lista de tareas conserva lo marcado', blocks[2].data.style === 'checklist' && blocks[2].data.items[0].meta.checked === true);
check('el pie de foto tambien se limpia', !/<script/.test(blocks[4].data.caption));
check('un relato vacio se guarda como nada', parseStory({ blocks: [{ type: 'paragraph', data: { text: '' } }] }).value === null);
check('un formato roto se rechaza', parseStory({ hola: 1 }).ok === false);
check('el resumen sale en texto plano', excerpt(JSON.parse(doc.value)) === 'Llegamos temprano. Llevar efectivo', excerpt(JSON.parse(doc.value)));

const vb = await call('visits', 'PUT', { token: A, query: { id: V1 }, body: { title: 'Semana Santa 2025', startDay: '2025-04-17', body: { blocks: [{ type: 'paragraph', data: { text: 'Hola <img src=x onerror=alert(1)>' } }] } } });
check('el endpoint guarda bloques ya limpios', vb.data.visit?.body?.blocks?.[0]?.data?.text === 'Hola', vb.data.visit?.body);
check('una visita marca el lugar como visitado', (await call('marks', 'GET', { token: A })).data.marks.includes('NIC.granada.granada'));

await call('visits', 'POST', { token: A, body: { placeId: 'NIC.masaya.masaya', title: 'Volcán Masaya', startDay: '2026-01-05' } });
await call('visits', 'POST', { token: A, body: { placeId: 'CRI', title: 'Costa Rica sin fecha' } });

const underNic = await call('visits', 'GET', { token: A, query: { under: 'NIC' } });
check('visitas dentro de Nicaragua: las dos, y no la de Costa Rica', underNic.data.visits?.length === 2, underNic.data);
check('las mas recientes primero', underNic.data.visits?.[0]?.title === 'Volcán Masaya');
check('la lista trae el nombre del lugar', underNic.data.visits?.[1]?.placeName === 'Granada, Granada, Nicaragua', underNic.data.visits?.[1]);
check('la lista no trae el texto', underNic.data.visits?.every((v) => !('body' in v)));
const underGranada = await call('visits', 'GET', { token: A, query: { under: 'NIC.granada' } });
check('dentro de un departamento', underGranada.data.visits?.length === 1);
check('"NIC.gran" no es prefijo de "NIC.granada"', (await call('visits', 'GET', { token: A, query: { under: 'NIC.gran' } })).data.visits.length === 0);

check('sin titulo', (await call('visits', 'POST', { token: A, body: { placeId: 'NIC', title: '  ' } })).status === 400);
check('termina antes de empezar',
  (await call('visits', 'POST', { token: A, body: { placeId: 'NIC', title: 'x', startDay: '2025-05-02', endDay: '2025-05-01' } })).status === 400);
check('fecha imposible',
  (await call('visits', 'POST', { token: A, body: { placeId: 'NIC', title: 'x', startDay: '2025-02-31' } })).status === 400);
check('fin sin inicio',
  (await call('visits', 'POST', { token: A, body: { placeId: 'NIC', title: 'x', endDay: '2025-02-01' } })).status === 400);

const upd = await call('visits', 'PUT', { token: A, query: { id: V1 }, body: { title: 'Semana Santa 2025', startDay: '2025-04-17', body: 'Editado' } });
check('editar visita', upd.status === 200 && upd.data.visit.title === 'Semana Santa 2025' && upd.data.visit.endDay === null, upd);

// Lo que mas importa: la otra persona no ve ni toca nada mio, y no sabe si existe.
check('otra persona no lee mi visita (404)', (await call('visits', 'GET', { token: B, query: { id: V1 } })).status === 404);
check('otra persona no la edita (404)', (await call('visits', 'PUT', { token: B, query: { id: V1 }, body: { title: 'hackeado' } })).status === 404);
check('otra persona no la borra (404)', (await call('visits', 'DELETE', { token: B, query: { id: V1 } })).status === 404);
check('otra persona no la ve en su lista', (await call('visits', 'GET', { token: B, query: { under: 'NIC' } })).data.visits.length === 0);
check('la visita sigue intacta', (await call('visits', 'GET', { token: A, query: { id: V1 } })).data.visit?.title === 'Semana Santa 2025');
check('una visita que no existe tambien es 404', (await call('visits', 'GET', { token: A, query: { id: 99999 } })).status === 404);

// ---------------------------------------------------------------- lugares (pines)
const pin1 = await call('pins', 'POST', {
  token: A, body: { visitId: V1, name: 'Convento San Francisco', kind: 'see', lat: 11.93117, lng: -85.95541, note: 'Museo y vista desde la torre' },
});
check('crear un lugar', pin1.status === 201 && pin1.data.pin.kind === 'see' && pin1.data.pin.lat === 11.93117, pin1);
const PIN1 = pin1.data.pin.id;
check('un tipo desconocido queda como "otro"',
  (await call('pins', 'POST', { token: A, body: { visitId: V1, name: 'X', kind: 'hackeo', lat: 11.9, lng: -85.9 } })).data.pin?.kind === 'other');
check('lugar sin nombre', (await call('pins', 'POST', { token: A, body: { visitId: V1, name: ' ', lat: 11, lng: -85 } })).status === 400);
check('lugar sin coordenadas', (await call('pins', 'POST', { token: A, body: { visitId: V1, name: 'X' } })).status === 400);
check('latitud imposible', (await call('pins', 'POST', { token: A, body: { visitId: V1, name: 'X', lat: 91, lng: 0 } })).status === 400);
check('coordenada vacia no es 0', (await call('pins', 'POST', { token: A, body: { visitId: V1, name: 'X', lat: '', lng: '' } })).status === 400);
check('otra persona no pone lugares en mi visita (404)',
  (await call('pins', 'POST', { token: B, body: { visitId: V1, name: 'X', lat: 11, lng: -85 } })).status === 404);

const pv = await call('pins', 'GET', { token: A, query: { visit: V1 } });
check('lugares de la visita', pv.data.pins?.length === 2, pv.data);
const pu = await call('pins', 'GET', { token: A, query: { under: 'NIC' } });
check('lugares dentro de Nicaragua, con su visita', pu.data.pins?.length === 2 && pu.data.pins[0].visitTitle === 'Semana Santa 2025' && pu.data.pins[0].placeId === 'NIC.granada.granada', pu.data.pins?.[0]);
check('ninguno dentro de Costa Rica', (await call('pins', 'GET', { token: A, query: { under: 'CRI' } })).data.pins.length === 0);
check('otra persona no ve mis lugares', (await call('pins', 'GET', { token: B, query: { under: 'NIC' } })).data.pins.length === 0);
check('otra persona no ve los de mi visita (404)', (await call('pins', 'GET', { token: B, query: { visit: V1 } })).status === 404);

const pe = await call('pins', 'PUT', { token: A, query: { id: PIN1 }, body: { name: 'Convento San Francisco', kind: 'see', lat: 11.9312, lng: -85.9554 } });
check('mover un lugar', pe.status === 200 && pe.data.pin.lat === 11.9312, pe);
check('editar solo el nombre conserva lo demas',
  (await call('pins', 'PUT', { token: A, query: { id: PIN1 }, body: { name: 'Convento' } })).data.pin?.lng === -85.9554);
check('otra persona no edita mi lugar (404)', (await call('pins', 'PUT', { token: B, query: { id: PIN1 }, body: { name: 'x' } })).status === 404);
check('otra persona no lo borra (404)', (await call('pins', 'DELETE', { token: B, query: { id: PIN1 } })).status === 404);

// ---------------------------------------------------------------- fotos
const up = await call('photos', 'POST', {
  token: A, query: { upload: 1 },
  body: { visitId: V1, width: 4032, height: 3024, takenAt: '2025:04:17 10:32:05', lat: 11.93, lng: -85.95 },
});
check('pedir subida de una foto', up.status === 201 && up.data.uploadURL?.startsWith('https://upload.imagedelivery.net/'), up);
check('la foto se pide privada (URL firmada)', cf.created[0]?.signed === 'true');
check('Cloudflare guarda de quien es', cf.created[0]?.meta?.userId === meA.data.me.id && cf.created[0]?.meta?.visitId === V1);
const P1 = up.data.photo.id;

check('otra persona no sube fotos a mi visita (404)',
  (await call('photos', 'POST', { token: B, query: { upload: 1 }, body: { visitId: V1 } })).status === 404);
check('confirmar antes de subir: 409', (await call('photos', 'POST', { token: A, query: { confirm: 1, id: P1 } })).status === 409);
check('sin confirmar no aparece en la galeria', (await call('photos', 'GET', { token: A, query: { visit: V1 } })).data.photos.length === 0);

cf.uploaded.add('cf-1');
const conf = await call('photos', 'POST', { token: A, query: { confirm: 1, id: P1 } });
check('confirmar cuando ya subio', conf.status === 200 && conf.data.photo.takenAt === '2025-04-17T10:32:05', conf);

const gal = await call('photos', 'GET', { token: A, query: { visit: V1 } });
check('la galeria trae la foto', gal.data.photos?.length === 1, gal.data);
const full = new URL(gal.data.photos[0].urls.full);
const expected = crypto.createHmac('sha256', 'clave-de-firma-de-prueba').update(`${full.pathname}?exp=${full.searchParams.get('exp')}`).digest('hex');
check('la URL va firmada como pide Cloudflare', full.pathname === '/hashDePrueba/cf-1/ttfull' && full.searchParams.get('sig') === expected, full.href);
const ttl = Number(full.searchParams.get('exp')) - Date.now() / 1000;
check('la firma vence en unas horas, no nunca', ttl > 3 * 3600 && ttl < 5 * 3600, ttl);
check('la galeria trae el GPS para el dueño', gal.data.photos[0].lat === 11.93 && gal.data.photos[0].lng === -85.95);

const half = await call('photos', 'POST', { token: A, query: { upload: 1 }, body: { visitId: V1, lat: 11.9 } });
cf.uploaded.add('cf-2');
check('coordenadas a medias no se guardan',
  (await call('photos', 'POST', { token: A, query: { confirm: 1, id: half.data.photo.id } })).data.photo.lat === null);

const list = await call('visits', 'GET', { token: A, query: { under: 'NIC.granada' } });
check('la lista de visitas trae cuantas fotos y la portada',
  list.data.visits[0].photoCount === 2 && list.data.visits[0].cover?.includes('/cf-1/ttcard'), list.data.visits[0]);

check('otra persona no ve la galeria (404)', (await call('photos', 'GET', { token: B, query: { visit: V1 } })).status === 404);
check('otra persona no borra mi foto (404)', (await call('photos', 'DELETE', { token: B, query: { id: P1 } })).status === 404);
check('otra persona no le cambia el pie (404)', (await call('photos', 'PUT', { token: B, query: { id: P1 }, body: { caption: 'x' } })).status === 404);
check('...y Cloudflare no borro nada', cf.deleted.length === 0);

check('poner pie de foto', (await call('photos', 'PUT', { token: A, query: { id: P1 }, body: { caption: '  Las isletas  ' } })).data.photo?.caption === 'Las isletas');
check('borrar una foto la borra en Cloudflare',
  (await call('photos', 'DELETE', { token: A, query: { id: half.data.photo.id } })).status === 200 && cf.deleted.includes('cf-2'));

// Una subida abandonada hace mas de una hora se limpia sola en la siguiente.
const stale = await call('photos', 'POST', { token: A, query: { upload: 1 }, body: { visitId: V1 } });
await db.execute({ sql: "UPDATE photos SET createdAt = '2020-01-01T00:00:00.000Z' WHERE id = ?", args: [stale.data.photo.id] });
await call('photos', 'POST', { token: A, query: { upload: 1 }, body: { visitId: V1 } });
check('la subida abandonada se borro, tambien en Cloudflare', cf.deleted.includes('cf-3') &&
  !(await db.execute({ sql: 'SELECT 1 FROM photos WHERE id = ?', args: [stale.data.photo.id] })).rows.length);

// ---------------------------------------------------------------- publicar
const pub = (query) => call('public', 'GET', { query });
check('sin publicar no sale en la portada', (await pub({ home: 1 })).data.recommendations.length === 0);
check('sin publicar, la visita publica es 404', (await pub({ visit: V1 })).status === 404);
check('otra persona no puede publicar mi visita (404)',
  (await call('visits', 'PUT', { token: B, query: { id: V1, publish: 1 }, body: { published: true } })).status === 404);
check('sin publicar, nadie copia mis lugares',
  (await call('wishes', 'POST', { token: B, body: { fromPinId: PIN1 } })).status === 404 &&
  (await call('visits', 'POST', { token: B, body: { fromPinId: PIN1, title: 'x' } })).status === 404);

const pv1 = await call('visits', 'PUT', { token: A, query: { id: V1, publish: 1 }, body: { published: true } });
check('publicar', pv1.status === 200 && pv1.data.visit.publishedAt, pv1.data);
const firstPublished = pv1.data.visit.publishedAt;
check('publicar otra vez conserva la fecha',
  (await call('visits', 'PUT', { token: A, query: { id: V1, publish: 1 }, body: { published: true } })).data.visit.publishedAt === firstPublished);

const home = await pub({ home: 1 });
const card = home.data.recommendations[0];
check('la portada trae la recomendacion con autor, portada y conteos',
  card?.id === V1 && card.author === 'moises' && card.cover?.includes('/ttcard') && card.photoCount === 1 && card.pinCount >= 1, card);
check('la portada trae los ultimos lugares', home.data.places.some((p) => p.id === PIN1 && p.author === 'moises'));
check('la portada trae cuantos paises', home.data.stats.countries === 1 && home.data.stats.visits === 1, home.data.stats);
check('la portada se cachea en el CDN', /s-maxage=60/.test(home.headers['cache-control']), home.headers);
check('un 404 publico no se cachea (al publicar aparece al tiro)', (await pub({ visit: 99999 })).headers['cache-control'] === 'no-store');

const pubVisit = await pub({ visit: V1 });
const json = JSON.stringify(pubVisit.data);
check('la visita publica trae relato, fotos y lugares', pubVisit.data.visit?.body?.blocks?.length && pubVisit.data.visit.photos.length === 1 && pubVisit.data.visit.pins.length >= 1);
check('lo publicado no trae el GPS de las fotos', !('lat' in pubVisit.data.visit.photos[0]) && !('lng' in pubVisit.data.visit.photos[0]));
check('lo publicado no trae la hora exacta de las fotos', !('takenAt' in pubVisit.data.visit.photos[0]) && pubVisit.data.visit.photos[0].takenOn === '2025-04-17');
check('lo publicado no trae correo, nombre completo ni ids de usuario',
  !/Moisés|@example|userId|email|fullName|cfId|passwordHash/.test(json), json.match(/Moisés|@example|userId|email|fullName|cfId|passwordHash/)?.[0]);
check('lugares publicados dentro de Nicaragua', (await pub({ under: 'NIC' })).data.pins.some((p) => p.id === PIN1));
check('feed paginado', (await pub({ feed: 1 })).data.visits.length === 1);

// Quiero ir / ya estuve, desde la cuenta de otra persona
const w1 = await call('wishes', 'POST', { token: B, body: { fromPinId: PIN1 } });
check('quiero ir desde un lugar publicado', w1.status === 201 && w1.data.wish.name === 'Convento' && w1.data.wish.lat === 11.9312 && w1.data.wish.placeId === 'NIC.granada.granada', w1.data);
check('quiero ir dos veces no duplica', (await call('wishes', 'POST', { token: B, body: { fromPinId: PIN1 } })).data.already === true);
check('quiero ir un municipio entero', (await call('wishes', 'POST', { token: B, body: { placeId: 'NIC.masaya.masaya', placeName: 'Masaya, Masaya, Nicaragua' } })).data.wish?.name === 'Masaya');
check('mi lista tiene los dos', (await call('wishes', 'GET', { token: B })).data.wishes.length === 2);
check('la lista de otro no la veo', (await call('wishes', 'GET', { token: A })).data.wishes.length === 0);
check('no borro lo de otro (404)', (await call('wishes', 'DELETE', { token: A, query: { id: w1.data.wish.id } })).status === 404);

const ya = await call('visits', 'POST', { token: B, body: { fromPinId: PIN1, title: 'Mi Granada' } });
check('ya estuve: crea MI visita en ese municipio', ya.status === 201 && ya.data.visit.placeId === 'NIC.granada.granada' && ya.data.visit.title === 'Mi Granada', ya.data);
check('...sin el relato de la otra persona', ya.data.visit.body === null);
const yaPins = (await call('pins', 'GET', { token: B, query: { visit: ya.data.visit.id } })).data.pins;
check('...con el lugar copiado, sin su nota', yaPins.length === 1 && yaPins[0].name === 'Convento' && yaPins[0].lat === 11.9312 && yaPins[0].note === null, yaPins);
check('...y sin sus fotos', (await call('photos', 'GET', { token: B, query: { visit: ya.data.visit.id } })).data.photos.length === 0);
const original = (await pub({ visit: V1 })).data.visit.pins.find((p) => p.id === PIN1);
check('el lugar original conserva su nota (no se copio, no se toco)', original?.note === 'Museo y vista desde la torre', original);

const unpub = await call('visits', 'PUT', { token: A, query: { id: V1, publish: 1 }, body: { published: false } });
check('dejar de publicar', unpub.data.visit.publishedAt === null);
check('despublicada ya no sale', (await pub({ visit: V1 })).status === 404 && (await pub({ home: 1 })).data.recommendations.length === 0);
check('lo que la otra persona ya guardo se queda (es suyo)', (await call('wishes', 'GET', { token: B })).data.wishes.length === 2);
check('borrar de la lista', (await call('wishes', 'DELETE', { token: B, query: { placeId: 'NIC.masaya.masaya' } })).status === 200 &&
  (await call('wishes', 'GET', { token: B })).data.wishes.length === 1);

check('borrar visita', (await call('visits', 'DELETE', { token: A, query: { id: V1 } })).status === 200);
check('borrar la visita se lleva sus fotos de Cloudflare', cf.deleted.includes('cf-1') && cf.deleted.includes('cf-4'), cf.deleted);
check('...y de la base', !(await db.execute({ sql: 'SELECT 1 FROM photos WHERE visitId = ?', args: [V1] })).rows.length);
check('borrar la visita se lleva sus lugares', !(await db.execute({ sql: 'SELECT 1 FROM pins WHERE visitId = ?', args: [V1] })).rows.length);
check('borrada ya no esta', (await call('visits', 'GET', { token: A, query: { id: V1 } })).status === 404);
check('sin visitas ni marca, el lugar deja de contar', !(await call('marks', 'GET', { token: A })).data.marks.includes('NIC.granada.granada'));

// ---------------------------------------------------------------- recuperacion y sesiones
for (let i = 0; i < 4; i++) await call('auth', 'POST', { body: { name: 'otra', password: 'mala-clave' } });
check('el quinto fallo todavia responde 401', (await call('auth', 'POST', { body: { name: 'otra', password: 'mala-clave' } })).status === 401);
check('despues de 5 fallos queda bloqueada', (await call('auth', 'POST', { body: { name: 'otra', password: 'viajera123' } })).status === 429);

check('codigo de recuperacion malo',
  (await call('auth', 'POST', { query: { recover: 1 }, body: { name: 'moises', code: 'AAAA-AAAA-AAAA', password: 'nuevaclave1' } })).status === 401);
const rec = await call('auth', 'POST', { query: { recover: 1 }, body: { name: 'moises', code: recoveryA.toLowerCase().replace(/-/g, ' '), password: 'nuevaclave1' } });
check('recuperar con el codigo (sin importar formato)', rec.status === 200 && rec.data.token && rec.data.recovery !== recoveryA, rec);
check('recuperar cierra las sesiones viejas', (await call('auth', 'GET', { token: A2 })).status === 401);
check('el codigo es de un solo uso',
  (await call('auth', 'POST', { query: { recover: 1 }, body: { name: 'moises', code: recoveryA, password: 'otraclave2' } })).status === 401);
const A3 = rec.data.token;

const A4 = (await call('auth', 'POST', { body: { name: 'moises', password: 'nuevaclave1' } })).data.token;
check('cambiar contraseña pide la actual',
  (await call('auth', 'PUT', { token: A3, query: { password: 1 }, body: { currentPassword: 'mala', password: 'otraclave3' } })).status === 401);
check('cambiar contraseña',
  (await call('auth', 'PUT', { token: A3, query: { password: 1 }, body: { currentPassword: 'nuevaclave1', password: 'otraclave3' } })).status === 200);
check('cambiar contraseña cierra las otras sesiones', (await call('auth', 'GET', { token: A4 })).status === 401);
check('...pero no la de quien la cambio', (await call('auth', 'GET', { token: A3 })).status === 200);

check('cerrar sesion', (await call('auth', 'POST', { token: A3, query: { logout: 1 } })).status === 200);
check('la sesion cerrada ya no sirve', (await call('auth', 'GET', { token: A3 })).status === 401);

console.log(`${passed} pruebas bien${failures.length ? `, ${failures.length} mal:\n${failures.join('\n')}` : ''}`);
process.exit(failures.length ? 1 : 0);
