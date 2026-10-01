// Crea (o actualiza) en Cloudflare Images los tamaños que usa la app.
//
//   node --env-file=.env scripts/cf-setup.mjs
//
// Las variantes son de TODA la cuenta de Cloudflare, que se comparte con otros
// proyectos: por eso llevan el prefijo "tt" y este script no toca ninguna otra.
//
// metadata "none": la foto que se entrega no lleva EXIF. El GPS de una foto
// dice donde estuvo alguien al metro; la app lo lee en el telefono antes de
// subir y lo guarda aparte, bajo su control, nunca dentro de la imagen.

const VARIANTS = {
  ttthumb: { fit: 'cover', width: 400, height: 400, metadata: 'none' }, // la cuadricula
  ttcard: { fit: 'cover', width: 960, height: 640, metadata: 'none' }, // portada de una visita
  ttfull: { fit: 'scale-down', width: 2560, height: 2560, metadata: 'none' }, // vista en grande
};

const { CF_ACCOUNT_ID: acc, CF_IMAGES_TOKEN: token } = process.env;
if (!acc || !token) {
  console.error('Faltan CF_ACCOUNT_ID o CF_IMAGES_TOKEN en el .env.');
  process.exit(1);
}
const api = async (method, path, body) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/images/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

const existing = (await api('GET', '/variants')).result?.variants ?? {};
for (const [id, options] of Object.entries(VARIANTS)) {
  // neverRequireSignedURLs: false -> una foto privada exige URL firmada tambien en esta variante.
  const body = { id, options, neverRequireSignedURLs: false };
  const r = existing[id] ? await api('PATCH', `/variants/${id}`, { options, neverRequireSignedURLs: false }) : await api('POST', '/variants', body);
  console.log(`${id}: ${r.success ? (existing[id] ? 'actualizada' : 'creada') : 'FALLA ' + JSON.stringify(r.errors)}`);
}
