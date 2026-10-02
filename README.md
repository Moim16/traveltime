# TravelTime

Los lugares que has visitado en el mundo, con lo que hiciste en cada uno. En el globo eliges un país, luego el departamento y luego el municipio, y ahí escribes la visita como un post de blog: el relato, las fotos y los lugares exactos donde estuviste. El mapa se va pintando a medida que viajas (*Nicaragua: 9 de 17 departamentos*). Si quieres, publicas una visita o un viaje, y otras personas guardan esos lugares en su lista "Quiero ir".

**Producción:** https://traveltime-tan.vercel.app (un push a `main` despliega solo).

Mismo stack que `deudas`: sin build, funciones serverless de Vercel y Turso/libSQL. Las fotos van a Cloudflare Images y los mapas a S3 detrás de CloudFront.

## Qué hay

| | |
|---|---|
| **Portada** (`#/`) | Encabezado con el globo girando detrás, cómo funciona, recomendaciones, últimos lugares publicados y, con cuenta, tu resumen y tu lista "Quiero ir". Botón "Instalar app" |
| **Mapa** (`#/mundo`) | Globo → país → departamento → ciudad para 198 países, búsqueda, filtro en las listas largas, tres estilos de fondo |
| **Visita** (`#/NIC.granada.granada/v/12`) | Relato por bloques, galería, lugares (pines), sugerencia de fechas desde las fotos, publicar, viaje al que pertenece |
| **Modo escritura** (`…/v/12/editar`) | Editor tipo blog a pantalla completa, con borrador en el teléfono |
| **Viaje** (`#/viaje/3`) | Visitas agrupadas: ruta numerada en el mapa y línea de tiempo |
| **Publicado** (`#/p/12`, `#/t/3`) | Una visita o un viaje vistos por cualquiera, con "Quiero ir", "Ya estuve", compartir y PDF |

## Servidor

| Endpoint | Qué hace |
|---|---|
| `api/auth.js` | Entrar con Google, salir, y el perfil (nombre, avatar, "Sobre mí"). La contraseña queda solo para cuentas de antes que aún no conectan Google |
| `api/marks.js` | Lo visitado: lo marcado más los lugares que tienen visitas |
| `api/visits.js` | Visitas de un lugar o de lo que hay dentro (por prefijo del id); publicar; "Ya estuve" (`fromPinId`) |
| `api/photos.js` | Fotos de una visita: pedir la subida, confirmarla, pie de foto y borrar |
| `api/pins.js` | Lugares puntuales de una visita (ver, comer, dormir, hacer, otro) |
| `api/trips.js` | Viajes: crear, renombrar, meter y sacar visitas, publicar; compañeros (invitar por usuario, aceptar, sacar, salir) |
| `api/wishes.js` | "Quiero ir": desde un lugar publicado o un municipio entero |
| `api/public.js` | Lo publicado, sin sesión: portada, visita, viaje y lugares dentro de un lugar |

El código compartido va en **`api/_lib/`**, no en un `lib/` en la raíz: Vercel publica como archivo estático todo lo de la raíz, y en el primer despliegue `/lib/auth.js` se podía descargar. `api/` no se publica, y lo que empieza con `_` no se vuelve función. Son 8 funciones de las 12 del plan Hobby.

```bash
npm test     # ~215 pruebas contra los handlers reales: base descartable y Cloudflare simulado
npm run dev  # http://localhost:3100, con las claves del .env (contra Turso si estan)
```

`scripts/dev.mjs` aplica las mismas cabeceras de `vercel.json`, así que lo que choca con la CSP falla en local igual que en producción. Los handlers se importan una vez: **si tocas `api/`, reinicia el servidor**. Para pruebas de punta a punta sin ensuciar Turso, levanta otro servidor con un `.env` sin `TURSO_*` ni `RESEND_*` (`PORT=3101`).

### Cuentas

- **Una sesión por dispositivo.** Entrar desde el teléfono no cierra la del computador. Cambiar la contraseña cierra las demás sesiones, y el código de recuperación las cierra todas. En la base solo queda el sha256 del token.
- **Solo Google** (`GOOGLE_CLIENT_ID`, el ID de cliente OAuth de tipo Aplicación web; no hace falta el secreto). El navegador recibe de Google un ID token firmado y el servidor lo verifica (`api/_lib/google.js`): firma RS256 con las claves públicas de Google, `aud`, emisor, vencimiento y correo verificado. El usuario sale del correo (`rosa.perez`, `rosa.perez2`…). El registro con contraseña está cerrado (`ALLOW_PASSWORD_SIGNUP=1` lo abre, solo lo usan las pruebas) y la contraseña solo abre cuentas que todavía no conectaron Google: mientras quede alguna, la ventana de entrar muestra "¿Tu cuenta es de antes?" (`legacyLogin` en `?config=1`) y desaparece sola. **Una cuenta de Google solo se une sola a una existente si el correo de esa cuenta estaba verificado**: si no, quien se registró con un correo ajeno se quedaría con la cuenta de su dueño.
- **Perfil** (`#/perfil`, y el público en `#/u/usuario`): avatar (inicial, ícono con color, la foto de Google, que se guarda en cada entrada, o una foto subida a Cloudflare, validada como propia), nombre, y el "Sobre mí" (presentación, dónde vive, idiomas, intereses de una lista fija, viaje soñado; `api/_lib/profile.js`). El público muestra solo eso y lo publicado: nunca marcas, visitas privadas, correo ni "Quiero ir".
- **Código de recuperación** de 12 caracteres, que se muestra una vez y es de un solo uso. 5 intentos fallidos bloquean 15 minutos.

### Privacidad: qué es de quién

- **Todo es privado hasta que se publica**, visita por visita o viaje por viaje. Lo demás de la cuenta (lo marcado, las visitas sin publicar, "Quiero ir") nunca sale.
- Lo ajeno responde **404, igual que lo que no existe**: no se puede averiguar que existe.
- **Qué muestra una visita publicada lo decide un solo archivo**, `api/_lib/public.js`. Sale el título, el lugar, las fechas, el relato, las fotos, los lugares y el `@usuario`. **No salen** el GPS ni la hora exacta de las fotos (solo el día), el correo, el nombre completo ni ids internos. Las pruebas buscan esas cadenas en la respuesta.
- **Un viaje publicado muestra solo sus visitas publicadas**, y su tarjeta (fechas, países, portada) se calcula con ellas. Con las privadas se filtraría cuándo y dónde estuvo la persona. El nombre y el resumen sí salen tal como se escribieron, y la confirmación lo avisa.
- **Compañeros de viaje.** El dueño invita por `@usuario`; la invitación aparece en la portada y en el panel. Al aceptar, el compañero **lee** todas las visitas del viaje (relato, fotos y lugares, **sin el GPS de las fotos**, que es solo de su dueño) y **suma las suyas**. No edita, borra, publica ni saca del viaje lo ajeno, y no renombra, publica ni borra el viaje. Salirse (o que lo saquen) deja sus visitas suyas, fuera del viaje. Un invitado que no aceptó no ve nada. La regla vive en `tripRole` y `readableVisit` (`api/_lib/trips.js`).
- **"Quiero ir" y "Ya estuve" copian solo la ubicación** (nombre, tipo y coordenadas del lugar). El relato y las fotos son de quien los escribió.
- **Caché de lo publicado:** el navegador no guarda (`no-cache`) y el CDN de Vercel guarda un minuto (`Vercel-CDN-Cache-Control`). Con `stale-while-revalidate` en `Cache-Control`, Chrome seguía mostrando hasta 5 minutos una visita despublicada. Un 404 no lo guarda nadie, porque si no ocultaría una visita recién publicada.

### Relato por bloques

Editor.js (en `vendor/editorjs/`, se carga al abrir el modo escritura): texto, títulos, listas (con viñetas, numeradas y de tareas), citas, separadores, y tres bloques propios: **aviso** con ícono, **foto** de la galería (o subida ahí mismo) y **lugar** de la visita. Al seleccionar texto: negrita, cursiva, resaltado y enlace.

- **Se guarda como JSON de bloques, nunca HTML.** El servidor descarta bloques y etiquetas que no estén en la lista (`api/_lib/story.js`) y el navegador vuelve a limpiar al mostrar (`js/story.js`). Son dos cercos, porque lo publicado lo lee cualquiera.
- **Borrador en el teléfono** un segundo después de escribir. Si se corta la señal o se cierra la pestaña, al volver se ofrece recuperarlo. Guardar sin conexión avisa que quedó en el teléfono.
- Los relatos en texto plano de la fase 1 se leen como párrafos.

### Fotos

Viven en **Cloudflare Images**; en la base queda lo necesario para listarlas.

1. El teléfono lee el **EXIF** (fecha y GPS) del archivo original.
2. La **redibuja en un canvas** a un máximo de 2560 px, en JPEG al 86 %: una foto de 4 MB sube en unos cientos de KB, y **la imagen que sube ya no lleva el GPS adentro**.
3. Pide una **URL de subida de un solo uso** y sube **directo a Cloudflare**. La foto no pasa por Vercel, que tiene un límite de 4.5 MB por petición.
4. **Confirma**: el servidor pregunta a Cloudflare si llegó, y recién entonces aparece.

- **Todas son privadas** (`requireSignedURLs`): cada URL va firmada con HMAC y vence a las 4 horas. Sin firma o con la firma vencida, Cloudflare responde 403. Esto está probado contra Cloudflare real.
- **Tamaños** (`npm run cf:setup`, una vez): `ttthumb` 400², `ttcard` 960×640 y `ttfull` hasta 2560. Llevan el prefijo `tt` porque las variantes son de toda la cuenta de Cloudflare, que se comparte con otros proyectos. Se entregan **sin metadatos**.
- **Cupos**: 2.000 por usuario y 150 por visita. Una subida abandonada se borra a la hora.
- **Borrar** (una foto o una visita) borra primero en Cloudflare y después en la base. Al revés quedaría una imagen huérfana ocupando cupo.
- En la visita, un **punto celeste** en el mapa donde se tomó cada foto (solo lo ve el dueño), y "**Tus fotos son del 17 al 20 abr · Usar estas fechas**".

### Turso

El esquema se crea solo (`CREATE TABLE IF NOT EXISTS` y `ALTER` idempotentes). **Las FOREIGN KEY no son una cascada confiable** en Turso: el `PRAGMA` es por conexión y el cliente web no la mantiene. Por eso borrar una visita borra a mano sus fotos, lugares y viaje.

## Mapas

```
país → división 1 → "ciudad" → lugares (pines)
NIC    Granada       Granada     Convento San Francisco, Isletas…
```

- **Países**: Natural Earth 1:50m, con el nombre en español. **Divisiones**: [geoBoundaries](https://www.geoboundaries.org) (ODbL), versión simplificada. **Lagos**: Natural Earth 1:10m, solo los de más de 50 km². **Fondo**: [OpenFreeMap](https://openfreemap.org), rotulado con `name:es`. **Motor**: MapLibre en `vendor/`.
- **La "ciudad" cambia de nivel por país** y se configura en `scripts/build-geo.mjs`: municipio (ADM2) en Nicaragua, comuna (ADM3) en Chile, cantón en Costa Rica, municipio (ADM3) en España, condado en EE. UU.
- **Un id contiene todo lo que está dentro de él**: `NIC` › `NIC.granada` › `NIC.granada.granada`. Lo visitado se cuenta por prefijo. El id sale del **nombre limpio**, no del `shapeID` de geoBoundaries, que cambia entre versiones y haría perder las visitas.
- **Se baja solo lo que se abre**: el país trae su primer nivel, y cada departamento sus ciudades (`geo/<ISO>/c/<depto>.json`). Brasil tiene 5.570 municipios y España 8.205.
- **Los lagos se restan** de las divisiones. geoBoundaries reparte el Cocibolca entre los municipios con líneas rectas, y Granada se veía medio lago.
- **Simplificación adaptativa**: si un archivo pasa de ~800 KB (primer nivel) o ~900 KB (ciudades de un departamento), se vuelve a simplificar más fuerte. Canadá bajó de 4,2 MB a 723 KB.
- Los nombres van en el **punto más interior** de cada polígono (`lx`/`ly`), no en el centroide, que en una media luna cae afuera.

```bash
npm run geo                    # todo (~15 min; baja a .geo-cache/)
npm run geo -- NIC BRA         # solo esos países
npm run geo:upload             # sube geo/ a S3 (claves de AWS en .env)
npm run geo:upload -- --prune  # y borra las versiones viejas (deja la actual y la anterior)
npm run vendor                 # después de actualizar maplibre-gl o @editorjs/*
```

### S3 detrás de CloudFront

Son ~140 MB y ~3.100 archivos, así que **no van en git ni en Vercel** (`geo/` está en `.gitignore` y en `.vercelignore`). Van al bucket `traveltimealfa` (us-east-2) y la app los lee de `https://d1kbjmlkyfoz97.cloudfront.net` (`js/config.js`).

- **Cada generación va en su propia carpeta** (`geo/<versión>/…`), con caché de un año. `geo/version.json` se sube al final y sin caché, así que nadie ve una versión a medias.
- El bucket es privado: solo CloudFront lo lee. La clave de IAM solo puede escribir en ese bucket. CloudFront comprime (`search.json`: 2,7 MB → 746 KB).
- En local se lee de `/geo`. Con `?geo=remoto` se lee de CloudFront, para probar una subida sin desplegar.

## Instalable y sin conexión

`manifest.webmanifest`, íconos (`scripts/make-icons.mjs`, dibujados píxel a píxel sin dependencias) y `sw.js`:

- **El cascarón** (HTML, JS, CSS, vendor) va primero a la red, así un cambio publicado se ve al recargar. Sin señal, sale lo guardado.
- **Los mapas de CloudFront y los mosaicos del fondo** salen de lo guardado (no cambian), con un tope de 3.000 mosaicos. El estilo del fondo va a la red, porque apunta a la edición del día del planeta.
- **`/api` y las fotos nunca se guardan** en el teléfono.
- Sin señal, `geo.js` usa la última versión de los mapas que conoció, que es la que el service worker tiene.

## Estilo

Coral para lo visitado y el progreso; tierra y agua frías a propósito. Globo con atmósfera en el mundo. Tres fondos (Claro, Oscuro, Colorido) más Automático, y la interfaz sigue al mapa. Animaciones al hacer scroll, con `prefers-reduced-motion` respetado. "Quiero ir" en el mapa es un anillo ámbar.

## Pendiente

- **Nombres** en inglés o sin tilde en muchos países (corregidos Nicaragua y Brasil). España va de comunidad a municipio sin la provincia.
- **Conteos de países grandes** levemente distintos de los oficiales (São Paulo 639 contra 645).
- **43 territorios sin divisiones** (Puerto Rico, Groenlandia…) se marcan enteros.
- **Estadísticas** (km, días viajando) y la **app Flutter** con la misma API.
