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
  GOOGLE_CLIENT_ID: 'cliente-de-prueba.apps.googleusercontent.com',
  ALLOW_PASSWORD_SIGNUP: '1', // la app es solo Google; las pruebas crean cuentas con clave
});
// Las claves publicas del Google de mentira (las llena la seccion de Google).
const googleJwks = { keys: [] };
const cf = { next: 0, uploaded: new Set(), deleted: [], created: [] };
// Claude de mentira: devuelve claude.reply y guarda lo que se le mando.
const claude = { reply: null, last: null, fail: false };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === 'https://www.googleapis.com/oauth2/v3/certs') {
    return { ok: true, status: 200, headers: { get: () => 'public, max-age=3600' }, json: async () => ({ keys: googleJwks.keys }) };
  }
  if (u === 'https://api.anthropic.com/v1/messages') {
    claude.last = JSON.parse(opts.body);
    if (claude.fail) return { ok: false, status: 529, json: async () => ({ error: { message: 'sobrecargado' } }) };
    return { ok: true, status: 200, json: async () => claude.reply };
  }
  const ok = (result) => ({ status: 200, json: async () => ({ success: true, result }) });
  if (u.endsWith('/images/v2/direct_upload')) {
    const id = `cf-${++cf.next}`;
    cf.created.push({ id, meta: JSON.parse(opts.body.get('metadata')), signed: opts.body.get('requireSignedURLs') });
    return ok({ id, uploadURL: `https://upload.imagedelivery.net/${id}` });
  }
  const m = u.match(/\/images\/v1\/([^/?]+)$/);
  if (m && opts.method === 'GET') return ok({ id: m[1], draft: !cf.uploaded.has(m[1]), meta: cf.created.find((c) => c.id === m[1])?.meta ?? {} });
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
  trips: (await import('../api/trips.js')).default,
  story: (await import('../api/story.js')).default,
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
check('color de texto de la lista queda', sanitizeInline('<span data-color="coral">rojo</span>') === '<span data-color="coral">rojo</span>');
check('un color que no es de la lista se va, el texto queda', sanitizeInline('<span data-color="#ff0000">x</span>') === 'x');
check('un span con estilo libre pierde el estilo', sanitizeInline('<span style="font-size:90px">x</span>') === 'x');
check('resaltado de color', sanitizeInline('<mark data-color="green">ok</mark>') === '<mark data-color="green">ok</mark>');
check('el resaltado de siempre sigue igual', sanitizeInline('<mark class="cdx-marker">a</mark>') === '<mark>a</mark>' && sanitizeInline('<mark data-color="amber">a</mark>') === '<mark>a</mark>');
check('el color no deja meter otros atributos', !/onclick/.test(sanitizeInline('<span data-color="blue" onclick="alert(1)">x</span>')));
const centered = parseStory({ blocks: [
  { type: 'header', data: { text: 'Hola', level: 2, align: 'center' } },
  { type: 'paragraph', data: { text: 'a', align: 'right' } },
  { type: 'quote', data: { text: 'q', caption: '', align: 'center' } },
] });
const cb = JSON.parse(centered.value).blocks;
check('centrar titulos y citas; otra alineacion no', cb[0].data.align === 'center' && !('align' in cb[1].data) && cb[2].data.align === 'center', cb);
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
const vt = await call('visits', 'PUT', { token: A, query: { id: V1 }, body: { title: 'Semana Santa 2025', startDay: '2025-04-17' } });
check('cambiar el titulo sin mandar el relato no lo borra', vt.data.visit?.body?.blocks?.[0]?.data?.text === 'Hola', vt.data.visit?.body);
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
check('la portada trae las ciudades de lo publicado, aunque no tengan pines', home.data.cities?.length === 1 && home.data.cities[0].placeId === 'NIC.granada.granada' && home.data.cities[0].author === 'moises', home.data.cities);
check('la portada trae cuantos paises', home.data.stats.countries === 1 && home.data.stats.visits === 1, home.data.stats);
check('la portada se guarda un minuto en el CDN', home.headers['vercel-cdn-cache-control']?.startsWith('max-age=60'), home.headers);
check('...pero no en el navegador (si no, una visita despublicada seguia viendose)', home.headers['cache-control'] === 'no-cache', home.headers);
const nf = await pub({ visit: 99999 });
check('un 404 publico no se guarda ni en el navegador ni en el CDN (al publicar aparece al tiro)', nf.headers['cache-control'] === 'no-store' && nf.headers['vercel-cdn-cache-control'] === 'no-store', nf.headers);

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

// ---------------------------------------------------------------- viajes
const leon = (await call('visits', 'POST', { token: A, body: { placeId: 'NIC.leon.leon', placeName: 'León, León, Nicaragua', title: 'León', startDay: '2025-04-21', endDay: '2025-04-23' } })).data.visit;
const sanJose = (await call('visits', 'POST', { token: A, body: { placeId: 'CRI.san-jose.san-jose', placeName: 'San José, San José, Costa Rica', title: 'San José (privada)', startDay: '2025-04-25' } })).data.visit;

const trip = await call('trips', 'POST', { token: A, body: { title: 'Centroamérica 2025', visitId: V1 } });
check('crear viaje con una visita adentro', trip.status === 201 && trip.data.trip.visitCount === 1, trip.data);
const T = trip.data.trip.id;
check('viaje sin nombre', (await call('trips', 'POST', { token: A, body: { title: ' ' } })).status === 400);
check('no meto en mi viaje una visita ajena (404)', (await call('trips', 'POST', { token: B, body: { title: 'x', visitId: V1 } })).status === 404);
check('meter otra visita', (await call('trips', 'PUT', { token: A, query: { id: T, visit: leon.id }, body: { in: true } })).data.trip?.visitCount === 2);
await call('trips', 'PUT', { token: A, query: { id: T, visit: sanJose.id }, body: { in: true } });
const td = await call('trips', 'GET', { token: A, query: { id: T } });
check('el viaje trae sus visitas en orden', JSON.stringify(td.data.trip.visits.map((v) => v.title)) === JSON.stringify(['Semana Santa 2025', 'León', 'San José (privada)']), td.data.trip.visits.map((v) => v.title));
check('las fechas salen de las visitas', td.data.trip.startDay === '2025-04-17' && td.data.trip.endDay === '2025-04-25', td.data.trip);
check('cuenta los paises', td.data.trip.countryCount === 2);
check('otra persona no ve mi viaje (404)', (await call('trips', 'GET', { token: B, query: { id: T } })).status === 404);
check('otra persona no mete visitas en mi viaje (404)', (await call('trips', 'PUT', { token: B, query: { id: T, visit: V1 }, body: { in: true } })).status === 404);
check('no meto una visita ajena en mi viaje (404)', (await call('trips', 'PUT', { token: A, query: { id: T, visit: ya.data.visit.id }, body: { in: true } })).status === 404);
check('la visita sabe en que viaje esta', (await call('visits', 'GET', { token: A, query: { id: leon.id } })).data.visit.tripId === T);
check('mis viajes', (await call('trips', 'GET', { token: A })).data.trips.length === 1 && (await call('trips', 'GET', { token: B })).data.trips.length === 0);
check('renombrar', (await call('trips', 'PUT', { token: A, query: { id: T }, body: { title: 'Centroamérica, Semana Santa 2025' } })).data.trip?.title === 'Centroamérica, Semana Santa 2025');

// Publicar el viaje: solo se ven las visitas publicadas, y nada de las privadas.
check('sin publicar, el viaje publico es 404', (await pub({ trip: T })).status === 404);
await call('trips', 'PUT', { token: A, query: { id: T, publish: 1 }, body: { published: true } });
await call('visits', 'PUT', { token: A, query: { id: leon.id, publish: 1 }, body: { published: true } });
const pt = await pub({ trip: T });
check('viaje publicado: solo la visita publicada', pt.status === 200 && pt.data.trip.visits.length === 1 && pt.data.trip.visits[0].title === 'León', pt.data.trip?.visits?.map((v) => v.title));
const ptJson = JSON.stringify(pt.data);
check('no se filtra la visita privada: ni titulo, ni fecha, ni pais',
  !/San José|2025-04-25|CRI|"title":"Semana Santa 2025"/.test(ptJson) && pt.data.trip.countryCount === 1 && pt.data.trip.startDay === '2025-04-21' && pt.data.trip.endDay === '2025-04-23', ptJson.match(/San José|2025-04-25|CRI|"title":"Semana Santa 2025"/)?.[0] ?? pt.data.trip);
check('el viaje publico no trae ids de usuario', !/userId|email|fullName/.test(ptJson));
check('la visita publicada sabe de su viaje publicado', (await pub({ visit: leon.id })).data.visit.trip?.id === T);
await call('trips', 'PUT', { token: A, query: { id: T, publish: 1 }, body: { published: false } });
check('si el viaje se despublica, la visita ya no lo nombra', (await pub({ visit: leon.id })).data.visit.trip === null);

// ---------------------------------------------------------------- compañeros de viaje
check('invitar a alguien que no existe', (await call('trips', 'POST', { token: A, query: { id: T, invite: 1 }, body: { name: 'nadie' } })).status === 404);
check('invitarse a si mismo', (await call('trips', 'POST', { token: A, query: { id: T, invite: 1 }, body: { name: 'moises' } })).status === 400);
check('solo el dueño invita', (await call('trips', 'POST', { token: B, query: { id: T, invite: 1 }, body: { name: 'otra' } })).status === 404);
const inv = await call('trips', 'POST', { token: A, query: { id: T, invite: 1 }, body: { name: '@OTRA' } });
check('invitar por usuario (con @ y sin importar mayusculas)', inv.status === 201 && inv.data.members.some((m) => m.name === 'otra' && m.status === 'invited'), inv.data);
check('invitar dos veces', (await call('trips', 'POST', { token: A, query: { id: T, invite: 1 }, body: { name: 'otra' } })).status === 409);
const invitesB = (await call('trips', 'GET', { token: B, query: { invites: 1 } })).data.invites;
check('la invitada ve su invitacion, con quien invita', invitesB.length === 1 && invitesB[0].tripId === T && invitesB[0].invitedBy === 'moises', invitesB);
check('invitada sin aceptar: todavia no ve el viaje (404)', (await call('trips', 'GET', { token: B, query: { id: T } })).status === 404);
check('...ni las visitas del viaje (404)', (await call('visits', 'GET', { token: B, query: { id: V1 } })).status === 404);
check('otro no puede aceptar por ella', (await call('trips', 'POST', { token: A, query: { id: T, respond: 1 }, body: { accept: true } })).status === 404);

const acc = await call('trips', 'POST', { token: B, query: { id: T, respond: 1 }, body: { accept: true } });
check('aceptar', acc.status === 200 && acc.data.trip.role === 'member', acc.data);
check('el viaje aparece en sus viajes, como compañera', (await call('trips', 'GET', { token: B })).data.trips.some((t) => t.id === T && t.role === 'member'));
const asB = (await call('trips', 'GET', { token: B, query: { id: T } })).data.trip;
check('la compañera ve las visitas del viaje, con su autor', asB.visits.some((v) => v.id === V1 && v.author === 'moises' && v.mine === false), asB.visits);
const vB = await call('visits', 'GET', { token: B, query: { id: V1 } });
check('la compañera lee la visita (marcada como ajena)', vB.status === 200 && vB.data.visit.mine === false && vB.data.visit.author === 'moises', vB.data);
const phB = (await call('photos', 'GET', { token: B, query: { visit: V1 } })).data.photos;
check('la compañera ve las fotos...', phB.length === 1);
check('...pero no su GPS (es solo del dueño)', phB[0].lat === null && phB[0].lng === null, phB[0]);
check('el dueño si ve su GPS', (await call('photos', 'GET', { token: A, query: { visit: V1 } })).data.photos[0].lat === 11.93);
check('la compañera ve los lugares de la visita', (await call('pins', 'GET', { token: B, query: { visit: V1 } })).data.pins.length >= 1);
check('la compañera no edita la visita ajena (404)', (await call('visits', 'PUT', { token: B, query: { id: V1 }, body: { title: 'x' } })).status === 404);
check('...ni la borra (404)', (await call('visits', 'DELETE', { token: B, query: { id: V1 } })).status === 404);
check('...ni la publica (404)', (await call('visits', 'PUT', { token: B, query: { id: V1, publish: 1 }, body: { published: true } })).status === 404);
check('...ni le sube fotos (404)', (await call('photos', 'POST', { token: B, query: { upload: 1 }, body: { visitId: V1 } })).status === 404);
check('...ni le pone lugares (404)', (await call('pins', 'POST', { token: B, body: { visitId: V1, name: 'x', lat: 11, lng: -85 } })).status === 404);
check('...ni la saca del viaje (404)', (await call('trips', 'PUT', { token: B, query: { id: T, visit: V1 }, body: { in: false } })).status === 404);
check('la compañera no renombra el viaje (403)', (await call('trips', 'PUT', { token: B, query: { id: T }, body: { title: 'mio' } })).status === 403);
check('...ni lo publica (403)', (await call('trips', 'PUT', { token: B, query: { id: T, publish: 1 }, body: { published: true } })).status === 403);
check('...ni lo borra (404)', (await call('trips', 'DELETE', { token: B, query: { id: T } })).status === 404);
check('...ni saca al dueño (404)', (await call('trips', 'DELETE', { token: B, query: { id: T, member: 'moises' } })).status === 404);

const myB = ya.data.visit.id; // la visita "Mi Granada" de la compañera
check('la compañera mete SU visita en el viaje', (await call('trips', 'PUT', { token: B, query: { id: T, visit: myB }, body: { in: true } })).status === 200);
const asA = (await call('trips', 'GET', { token: A, query: { id: T } })).data.trip;
check('el dueño la ve en el viaje, como de ella', asA.visits.some((v) => v.id === myB && v.author === 'otra' && v.mine === false));
check('...y la lee (de lectura)', (await call('visits', 'GET', { token: A, query: { id: myB } })).data.visit?.mine === false);
check('...pero no la edita (404)', (await call('visits', 'PUT', { token: A, query: { id: myB }, body: { title: 'x' } })).status === 404);
check('los compañeros del viaje', JSON.stringify(asA.members.map((m) => `${m.name}:${m.role}:${m.status}`)) === JSON.stringify(['moises:owner:accepted', 'otra:member:accepted']), asA.members);

check('la compañera se sale del viaje', (await call('trips', 'DELETE', { token: B, query: { id: T, member: 'otra' } })).status === 200);
check('su visita queda suya, fuera del viaje', (await call('visits', 'GET', { token: B, query: { id: myB } })).data.visit?.tripId === null);
check('y ya no ve el viaje ni las visitas (404)',
  (await call('trips', 'GET', { token: B, query: { id: T } })).status === 404 && (await call('visits', 'GET', { token: B, query: { id: V1 } })).status === 404);
await call('trips', 'POST', { token: A, query: { id: T, invite: 1 }, body: { name: 'otra' } });
check('rechazar una invitacion', (await call('trips', 'POST', { token: B, query: { id: T, respond: 1 }, body: { accept: false } })).status === 200 &&
  (await call('trips', 'GET', { token: B, query: { invites: 1 } })).data.invites.length === 0);

check('sacar una visita del viaje', (await call('trips', 'PUT', { token: A, query: { id: T, visit: sanJose.id }, body: { in: false } })).data.trip?.visitCount === 2);
check('borrar el viaje', (await call('trips', 'DELETE', { token: A, query: { id: T } })).status === 200);
check('las visitas quedan, sueltas', (await call('visits', 'GET', { token: A, query: { id: leon.id } })).data.visit?.tripId === null);
await call('visits', 'DELETE', { token: A, query: { id: leon.id } });
await call('visits', 'DELETE', { token: A, query: { id: sanJose.id } });

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

// ---------------------------------------------------------------- entrar con Google
// Un Google de mentira: un par de claves RSA propio y su JWKS servido por el fetch de prueba.
const gkeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const gjwk = { ...gkeys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
googleJwks.keys = [gjwk];
const gtoken = (claims, { key = gkeys.privateKey, kid = 'k1', alg = 'RS256' } = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'cliente-de-prueba.apps.googleusercontent.com', iat: now, exp: now + 3600, email_verified: true, ...claims })).toString('base64url');
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${s}`;
};
const gcall = (claims, opts, extra = {}) => call('auth', 'POST', { query: { google: 1, ...extra.query }, body: { credential: gtoken(claims, opts) }, token: extra.token });

const cfg = await call('auth', 'GET', { query: { config: 1 } });
check('la config publica trae el id de cliente de Google', cfg.status === 200 && cfg.data.googleClientId === 'cliente-de-prueba.apps.googleusercontent.com', cfg.data);

const g1 = await gcall({ sub: 'g-111', email: 'Rosa.Pérez@gmail.com', name: 'Rosa Pérez' });
check('entrar con Google crea la cuenta', g1.status === 201 && g1.data.token && g1.data.user.email === 'rosa.pérez@gmail.com', g1.data);
check('el usuario sale del correo, sin tildes', g1.data.user.name === 'rosa.perez', g1.data.user.name);
check('con Google no hay codigo de recuperacion', !('recovery' in g1.data));
const g2 = await gcall({ sub: 'g-111', email: 'rosa.perez@gmail.com' });
check('la segunda vez entra a la misma cuenta', g2.status === 200 && g2.data.user.id === g1.data.user.id, g2.data);
const g3 = await gcall({ sub: 'g-222', email: 'rosa.perez@otro.com' });
check('otro con el mismo comienzo de correo recibe otro usuario', g3.data.user?.name === 'rosa.perez2', g3.data.user);
const meG = await call('auth', 'GET', { token: g1.data.token });
check('la cuenta de Google se ve como tal', meG.data.me.hasGoogle === true && meG.data.me.hasPassword === false, meG.data.me);
check('una cuenta de Google no entra con contraseña vacia',
  (await call('auth', 'POST', { body: { name: 'rosa.perez', password: '' } })).status === 401 &&
  (await call('auth', 'POST', { body: { name: 'rosa.perez', password: 'cualquiera1' } })).status === 401);

check('token de otra app (aud)', (await gcall({ sub: 'g-x', email: 'x@gmail.com', aud: 'otra-app' })).status === 401);
check('token vencido', (await gcall({ sub: 'g-x', email: 'x@gmail.com', exp: Math.floor(Date.now() / 1000) - 3600 })).status === 401);
check('token de otro emisor', (await gcall({ sub: 'g-x', email: 'x@gmail.com', iss: 'https://malo.com' })).status === 401);
check('correo sin verificar por Google', (await gcall({ sub: 'g-x', email: 'x@gmail.com', email_verified: false })).status === 401);
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
check('firma falsa', (await gcall({ sub: 'g-x', email: 'x@gmail.com' }, { key: otherKey })).status === 401);
check('alg none no pasa', (await call('auth', 'POST', { query: { google: 1 }, body: { credential: gtoken({ sub: 'g-x', email: 'x@gmail.com' }, { alg: 'none' }) } })).status === 401);
check('basura', (await call('auth', 'POST', { query: { google: 1 }, body: { credential: 'no.es.jwt' } })).status === 401);

// La cuenta "otra" se registro con contraseña y SIN confirmar el correo: si
// alguien entra con Google con ese correo, no se une sola (podria ser de otro).
await db.execute({ sql: "UPDATE users SET email = 'otra@gmail.com' WHERE name = 'otra'" });
const pre = await gcall({ sub: 'g-333', email: 'otra@gmail.com' });
check('correo de una cuenta sin verificar: no se une solo (409)', pre.status === 409 && /contraseña/.test(pre.data.error), pre.data);
// Si estaba verificado (confirmo el codigo por correo), si se une.
await db.execute({ sql: "UPDATE users SET emailVerified = 1 WHERE name = 'otra'" });
const join = await gcall({ sub: 'g-333', email: 'otra@gmail.com' });
check('correo verificado: entra a esa cuenta y queda conectada', join.status === 200 && join.data.user.name === 'otra', join.data);

// Conectar Google desde la cuenta, con sesion.
const linkSession = (await call('auth', 'POST', { body: { name: 'moises', password: 'otraclave3' } })).data.token;
check('conectar Google exige sesion', (await gcall({ sub: 'g-444', email: 'moises@gmail.com' }, undefined, { query: { link: 1 } })).status === 401);
check('no se conecta una cuenta de Google que ya es de otro', (await gcall({ sub: 'g-111', email: 'rosa.perez@gmail.com' }, undefined, { query: { link: 1 }, token: linkSession })).status === 409);
check('conectar Google a mi cuenta', (await gcall({ sub: 'g-444', email: 'moises@gmail.com' }, undefined, { query: { link: 1 }, token: linkSession })).status === 200);
const viaG = await gcall({ sub: 'g-444', email: 'moises@gmail.com' });
check('despues entro con Google a mi misma cuenta', viaG.data.user?.name === 'moises', viaG.data);

// ---------- Solo Google y perfil ----------
{

check('con Google conectado, la contraseña ya no abre (403)',
  (await call('auth', 'POST', { body: { name: 'moises', password: 'otraclave3' } })).status === 403);
check('una contraseña equivocada sigue diciendo lo de siempre (no cuenta quien existe)',
  (await call('auth', 'POST', { body: { name: 'moises', password: 'malmalmal1' } })).status === 401);
const gPic = 'https://lh3.googleusercontent.com/a/foto-de-prueba';
const withPic = await gcall({ sub: 'g-444', email: 'moises@gmail.com', picture: gPic });
const G = withPic.data.token;
const meWithPic = (await call('auth', 'GET', { token: G })).data.me;
check('la foto de Google queda guardada para elegirla', meWithPic.hasGooglePicture === true && meWithPic.avatar.kind === 'initial', meWithPic);
await gcall({ sub: 'g-555', email: 'raro@gmail.com', picture: 'https://malo.com/x.png' });
check('una foto que no es de Google no se guarda',
  (await db.execute("SELECT googlePicture FROM users WHERE googleSub = 'g-555'")).rows[0].googlePicture === null);

const putProfile = (body, token = G) => call('auth', 'PUT', { query: { profile: 1 }, body, token });
const em = await putProfile({ avatar: { kind: 'emoji', emoji: '🧭', color: '#10b981' }, fullName: 'Moisés M.' });
check('avatar con icono y color, y el nombre', em.status === 200 && em.data.me.avatar.emoji === '🧭' && em.data.me.avatar.color === '#10b981' && em.data.me.fullName === 'Moisés M.', em.data);
check('un icono fuera de la lista no', (await putProfile({ avatar: { kind: 'emoji', emoji: '💩' } })).status === 400);
check('un color fuera de la lista queda en el de siempre', (await putProfile({ avatar: { kind: 'emoji', emoji: '🧭', color: 'red' } })).data.me.avatar.color === '#f2545b');
check('el nombre no puede quedar vacio', (await putProfile({ fullName: '   ' })).status === 400);
const gAv = await putProfile({ avatar: { kind: 'google' } });
check('usar la foto de Google', gAv.data.me.avatar.kind === 'google' && gAv.data.me.avatar.url === gPic, gAv.data);
check('perfil sin sesion', (await putProfile({ fullName: 'x' }, null)).status === 401);

const up = await call('auth', 'POST', { query: { avatarUpload: 1 }, token: G });
check('pedir donde subir la foto de perfil', up.status === 200 && up.data.uploadURL && up.data.cfId, up.data);
check('la foto sin subir todavia no se acepta', (await putProfile({ avatar: { kind: 'photo', cfId: up.data.cfId } })).status === 400);
cf.uploaded.add(up.data.cfId);
const ph = await putProfile({ avatar: { kind: 'photo', cfId: up.data.cfId } });
check('foto de perfil subida', ph.status === 200 && ph.data.me.avatar.kind === 'photo' && ph.data.me.avatar.url.includes(up.data.cfId), ph.data);
// Una foto de una visita de otra persona: su id se ve en las URL firmadas.
const stranger = cf.created.find((c) => c.meta.kind !== 'avatar');
cf.uploaded.add(stranger.id);
check('no se puede poner de avatar una foto que no se subio como avatar mio',
  (await putProfile({ avatar: { kind: 'photo', cfId: stranger.id } })).status === 400);
const up2 = await call('auth', 'POST', { query: { avatarUpload: 1 }, token: G });
cf.uploaded.add(up2.data.cfId);
await putProfile({ avatar: { kind: 'photo', cfId: up2.data.cfId } });
check('al cambiar de foto, la anterior se borra de Cloudflare', cf.deleted.includes(up.data.cfId));
check('el login trae el avatar', (await gcall({ sub: 'g-444', email: 'moises@gmail.com', picture: gPic })).data.user.avatar.kind === 'photo');
  // "Sobre mi" y perfil publico.
  const ab = await putProfile({
    bio: 'Me gusta viajar lento.\n\n\n\nY comer bien.', livesIn: '  Managua,   Nicaragua ', languages: ['Español', 'Inglés', 'Español', ''],
    interests: ['food', 'slow', 'hackear'], dream: 'Japón en primavera',
  });
  const about = ab.data.me?.about;
  check('sobre mi: se guarda limpio', about?.bio === 'Me gusta viajar lento.\n\nY comer bien.' && about.livesIn === 'Managua, Nicaragua'
    && about.languages.join() === 'Español,Inglés' && about.interests.join() === 'food,slow' && about.dream === 'Japón en primavera', about);
  check('una bio muy larga no', (await putProfile({ bio: 'x'.repeat(501) })).status === 400);
  check('demasiados idiomas no', (await putProfile({ languages: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).status === 400);
  check('borrar un dato del sobre mi', (await putProfile({ dream: '' })).data.me.about.dream === null);
  const st = ab.data.me.stats;
  check('mis cifras incluyen lo privado', st && st.visits >= 1 && st.countries >= 1, st);
  const pp = await call('public', 'GET', { query: { user: 'MOISES' } });
  check('perfil publico por usuario (sin importar mayusculas)', pp.status === 200 && pp.data.profile.name === 'moises' && pp.data.profile.verified === true, pp.data);
  check('el perfil publico trae el sobre mi', pp.data.profile.about.livesIn === 'Managua, Nicaragua');
  check('el perfil publico no trae correo, id ni cifras privadas',
    !('email' in pp.data.profile) && !('id' in pp.data.profile) && !('visits' in pp.data.profile.stats) && !('wishes' in pp.data.profile.stats), pp.data.profile);
  check('el perfil publico solo lista lo publicado', pp.data.visits.every((v) => v.author === 'moises') && pp.data.profile.stats.published === pp.data.visits.length, pp.data);
  check('un viajero que no existe: 404', (await call('public', 'GET', { query: { user: 'nadie-asi' } })).status === 404);
}

// ---------- Escríbelo por mí (Claude de mentira) ----------
{
  // Sesiones nuevas: las de arriba se cerraron al cambiar la contraseña.
  const A = (await gcall({ sub: 'g-444', email: 'moises@gmail.com' })).data.token;
  const B = (await gcall({ sub: 'g-111', email: 'rosa.perez@gmail.com' })).data.token;
  const noKey = await call('story', 'POST', { token: A, query: { visit: 1 }, body: {} });
  check('sin clave de Claude: 503', noKey.status === 503, noKey.data);
  process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';

  const vs = await call('visits', 'POST', { token: A, body: { placeId: 'NIC.masaya.masaya', placeName: 'Masaya, Masaya, Nicaragua', title: 'Volcán y mercado', startDay: '2025-03-01' } });
  const VS = vs.data.visit.id;
  const up = await call('photos', 'POST', { token: A, query: { upload: 1 }, body: { visitId: VS, width: 800, height: 600, takenAt: '2025:03:01 17:40:00' } });
  cf.uploaded.add(cf.created.at(-1).id);
  await call('photos', 'POST', { token: A, query: { confirm: 1, id: up.data.photo.id } });
  const pin = await call('pins', 'POST', { token: A, body: { visitId: VS, name: 'Mirador del cráter', kind: 'see', lat: 11.98, lng: -86.16, note: 'Ir al atardecer' } });
  const P = up.data.photo.id;
  const PIN = pin.data.pin.id;

  claude.reply = {
    content: [{
      type: 'tool_use', name: 'escribir_relato',
      input: { blocks: [
        { type: 'header', level: 2, text: 'Fuego al atardecer' },
        { type: 'paragraph', text: 'Llegué al <b>cráter</b> justo a tiempo.<script>alert(1)</script>' },
        { type: 'photo', photoId: P, caption: 'La lava al fondo' },
        { type: 'photo', photoId: P, caption: 'repetida' },
        { type: 'photo', photoId: 999999, caption: 'de otra persona' },
        { type: 'place', pinId: PIN },
        { type: 'place', pinId: 999999 },
        { type: 'callout', emoji: '💡', text: 'Ir al atardecer' },
        { type: 'inventado', text: 'x' },
      ] },
    }],
  };
  const st = await call('story', 'GET', { token: A });
  check('la IA esta disponible y quedan los del dia', st.data.ready === true && st.data.left === 15, st.data);
  const d = await call('story', 'POST', { token: A, query: { visit: VS }, body: { notes: 'Fuimos con mi hermana', tone: 'poetico' } });
  const types = (d.data.blocks ?? []).map((b) => b.type).join(',');
  check('el borrador vuelve como bloques del editor', d.status === 200 && types === 'header,paragraph,photo,place,callout', d.data);
  check('lo que escribio Claude se limpia como cualquier relato', !/script/.test(JSON.stringify(d.data.blocks)) && d.data.blocks[1].data.text.includes('<b>cráter</b>'));
  check('solo fotos y lugares de esta visita, sin repetir', d.data.blocks.filter((b) => b.type === 'photo').length === 1 && d.data.blocks[3].data.pinId === PIN);
  check('cuenta el uso', d.data.left === 14, d.data);
  const sent = claude.last;
  const text = sent.messages[0].content.find((c) => c.type === 'text').text;
  check('Claude recibe el lugar, el lugar marcado, las notas y el tono', /Masaya/.test(text) && /Mirador del cráter/.test(text) && /hermana/.test(text) && /sensorial/.test(text), text);
  check('Claude mira la foto (URL firmada) y responde por la herramienta',
    sent.messages[0].content.some((c) => c.type === 'image' && /imagedelivery\.net/.test(c.source.url)) && sent.tools?.[0]?.name === 'escribir_relato' && !sent.tool_choice);
  check('una visita ajena: 404', (await call('story', 'POST', { token: B, query: { visit: VS }, body: {} })).status === 404);

  claude.fail = true;
  const bad = await call('story', 'POST', { token: A, query: { visit: VS }, body: {} });
  claude.fail = false;
  check('si Claude falla: 502 y el intento no cuenta', bad.status === 502 && (await call('story', 'GET', { token: A })).data.left === 14, bad.data);
  await db.execute({ sql: "UPDATE ai_usage SET n = 15 WHERE userId = (SELECT userId FROM visits WHERE id = ?)", args: [VS] });
  check('con el cupo del dia usado: 429', (await call('story', 'POST', { token: A, query: { visit: VS }, body: {} })).status === 429);
  delete process.env.ANTHROPIC_API_KEY;

  // Tu año en viajes: la visita de Masaya (marzo de 2025), con su foto y su lugar.
  const w = await call('visits', 'GET', { token: A, query: { wrapped: 2025 } });
  const W = w.data.wrapped;
  check('el año en viajes trae las visitas del año en orden', w.status === 200 && W.visits.some((v) => v.id === VS) && W.year === 2025, w.data);
  check('cuenta paises, fotos, lugares, dias y el mes', W.countries.includes('NIC') && W.photos >= 1 && W.pins >= 1 && W.travelDays >= 1 && W.months[2] >= 1, W);
  check('los años disponibles', w.data.years.includes(2025), w.data.years);
  const wb = await call('visits', 'GET', { token: B, query: { wrapped: 2025 } });
  check('el año de otra persona no trae lo mio', !wb.data.wrapped.visits.some((v) => v.id === VS));
  check('un año raro: 400', (await call('visits', 'GET', { token: A, query: { wrapped: 99999 } })).status === 400);
}

console.log(`${passed} pruebas bien${failures.length ? `, ${failures.length} mal:\n${failures.join('\n')}` : ''}`);
process.exit(failures.length ? 1 : 0);
