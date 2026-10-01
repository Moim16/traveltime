// De donde salen los mapas.
//
// En local, de /geo (los genera `npm run geo` y los sirve scripts/dev.mjs).
// Publicada, de CloudFront delante del bucket S3 (los sube `npm run geo:upload`).
// Con ?geo=remoto en la URL, el local tambien lee de CloudFront: sirve para
// probar una subida sin desplegar.

const CLOUDFRONT = 'https://d1kbjmlkyfoz97.cloudfront.net'; // delante de s3://traveltimealfa

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const forceRemote = new URLSearchParams(location.search).get('geo') === 'remoto';

export const GEO_REMOTE = Boolean(CLOUDFRONT) && (!local || forceRemote);
export const GEO_BASE = GEO_REMOTE ? `${CLOUDFRONT}/geo` : '/geo';
