# TravelTime

Los lugares que has visitado en el mundo, con lo que hiciste en cada uno. Abres el mapa, eliges un país, después el departamento y después el municipio, y ahí escribes la visita: el relato, las fotos, los enlaces y los lugares puntuales donde estuviste. El mapa se va pintando a medida que viajas: *Nicaragua: 9 de 17 departamentos*.

Mismo stack que `deudas`: sin build, funciones serverless de Vercel y Turso/libSQL. Las fotos van a Cloudflare Images.

> **Estado: fase 1 completa en local.** Están el globo con el recorrido mundo → país → departamento → ciudad para **198 países**, la búsqueda, tres estilos de mapa, las **cuentas**, las **visitas con relato** y la **galería de fotos**. Falta pasar a Turso y desplegar en Vercel.

## Cuentas y datos

Sin cuenta se puede recorrer el mapa. Para marcar lugares y escribir visitas hay que entrar, y todo eso vive en la base: Turso en producción y `data/traveltime.db` en local.

| Endpoint | Qué hace |
|---|---|
| `api/auth.js` | Registro (con código por correo si hay `RESEND_API_KEY`), entrada, salida, código de recuperación y cambio de contraseña |
| `api/marks.js` | Lo visitado: lo marcado más los lugares que tienen visitas |
| `api/visits.js` | Visitas de un lugar o de todo lo que hay dentro de él (por prefijo del id) |

- **Una sesión por dispositivo.** Entrar desde el teléfono no cierra la del computador. Cambiar la contraseña cierra las demás sesiones, y usar el código de recuperación las cierra todas. En la base solo queda el sha256 del token.
- **Una visita marca su lugar.** Para que un lugar deje de contar como visitado hay que borrar sus visitas, no basta con desmarcarlo.
- **Cada visita guarda el nombre de su lugar** ("Granada, Granada, Nicaragua"). Así, la lista de un país no necesita bajar los mapas de todos sus departamentos.
- **Una visita ajena responde 404, igual que una que no existe.**

| `api/photos.js` | Fotos de una visita: pedir la subida, confirmarla, pie de foto y borrar |

El código compartido del servidor va en **`api/_lib/`**, no en un `lib/` en la raíz. Vercel publica como archivo estático todo lo que está en la raíz, así que `/lib/auth.js` se podía descargar (pasó en el primer despliegue). La carpeta `api/` no se publica, y lo que empieza con `_` no se convierte en función.

```bash
npm test     # 72 pruebas contra los handlers reales, en una base descartable y con Cloudflare simulado
```

## Fotos

Viven en **Cloudflare Images**; en la base solo queda lo necesario para listarlas.

1. **El teléfono lee el EXIF** (fecha y GPS) del archivo original.
2. **La redibuja en un canvas** a un máximo de 2560 px, en JPEG al 86 %. Así una foto de 4 MB sube en unos cientos de KB, y **la imagen que sube ya no lleva el GPS adentro**.
3. **Pide al servidor una URL de subida de un solo uso** (`?upload=1`) y sube **directo a Cloudflare**. La foto no pasa por Vercel, que tiene un límite de 4.5 MB por petición.
4. **Confirma** (`?confirm=1`): el servidor le pregunta a Cloudflare si la foto llegó, y recién entonces aparece en la galería.

- **Todas las fotos son privadas** (`requireSignedURLs`). El servidor entrega cada URL firmada con HMAC y con vencimiento a las 4 horas. Sin firma, o con la firma vencida, Cloudflare responde 403. Esto está probado contra Cloudflare real, no solo en las pruebas.
- **Tamaños** (`npm run cf:setup`, una sola vez): `ttthumb` 400×400, `ttcard` 960×640 y `ttfull` hasta 2560. Llevan el prefijo `tt` porque las variantes son de toda la cuenta de Cloudflare, que se comparte con otros proyectos. Todas se entregan **sin metadatos**.
- **Cupos**: 2.000 fotos por usuario y 150 por visita. Las 100.000 de la cuenta son de todos los usuarios.
- **Una subida abandonada** (se cerró la pestaña o se cayó la red) se borra sola una hora después, la próxima vez que esa persona sube algo.
- **Al borrar una foto o una visita se borra primero en Cloudflare** y después en la base. Si falla Cloudflare, la fila queda y se puede reintentar; al revés quedaría una imagen huérfana ocupando cupo.
- **Fotos HEIC**: el Safari del iPhone las convierte solo. Chrome en Windows no las abre, y la app lo dice con nombre de archivo.

---

## Cómo se ordena el mundo

```
país → división 1 → "ciudad" → lugares (pines)
NIC    Granada       Granada     Convento San Francisco, Isletas…
```

Lo que se ve como "ciudad" no es el mismo nivel administrativo en todos los países, y por eso se configura por país en `scripts/build-geo.mjs`:

| País | División 1 | "Ciudad" |
|---|---|---|
| Nicaragua | Departamento (ADM1) | Municipio (ADM2) |
| Chile | Región (ADM1) | Comuna (**ADM3**, porque el ADM2 son provincias) |
| Costa Rica | Provincia (ADM1) | Cantón (ADM2) |

En Estados Unidos el ADM2 son condados y no ciudades. Para países así, la "ciudad" van a ser puntos de GeoNames en vez de polígonos.

**Un id contiene a todo lo que está dentro de él:** `NIC` › `NIC.granada` › `NIC.granada.granada`. Para saber si visitaste algo de Nicaragua basta comparar prefijos, sin guardar el árbol aparte. El id sale del nombre limpio y no del `shapeID` de geoBoundaries, porque ese cambia entre versiones de los datos y con él se perderían las visitas guardadas.

## Mapas

- **Países**: Natural Earth 1:50m, con el nombre en español.
- **Divisiones**: [geoBoundaries](https://www.geoboundaries.org) (licencia ODbL). Los municipios no traen a qué departamento pertenecen, así que se cruzan por punto interior.
- **Fondo**: [OpenFreeMap](https://openfreemap.org) (gratis, sin clave), rotulado en español con `name:es`.
- **Motor**: MapLibre, copiado en `vendor/` para que la CSP siga en `'self'`.

```bash
npm run geo                    # mundo + todos los países (~10 min la primera vez; baja a .geo-cache/)
npm run geo -- NIC BRA         # solo esos países
npm run geo:upload             # sube geo/ a S3 (claves de AWS en .env)
npm run geo:upload -- --prune  # y borra las versiones viejas (deja la actual y la anterior)
npm run vendor                 # después de actualizar maplibre-gl
```

### Dónde viven: S3 detrás de CloudFront

Los mapas pesan 139 MB y son 3.091 archivos, así que **no van en git ni en Vercel** (`geo/` está en `.gitignore` y en `.vercelignore`). Se generan en tu PC y se suben al bucket `traveltimealfa` (us-east-2). La app los lee de `https://d1kbjmlkyfoz97.cloudfront.net`, que se configura en `js/config.js`.

- **Cada generación va en su propia carpeta**: `geo/<versión>/NIC/adm1.json`, con caché de un año (`immutable`). Un archivo publicado nunca cambia; lo que cambia es la carpeta.
- **`geo/version.json` se sube al final y sin caché.** La app lo lee primero para saber qué carpeta pedir, así que nadie ve una versión a medias.
- **CloudFront comprime**: `search.json` pasa de 2,7 MB a 746 KB.
- **El bucket es privado**: solo CloudFront lo lee (Origin Access Control). La clave de IAM de `.env` solo puede escribir en ese bucket.
- **En local** la app lee de `/geo`. Con `?geo=remoto` en la URL lee de CloudFront, para probar una subida sin desplegar.

La fuente trae los nombres sucios ("El Viejo (Municipio)", "Matagalpa (Departemento)", las regiones autónomas en inglés, "Rio de Jeneiro"). `cleanName` quita el tipo de división y `names` corrige a mano lo demás. **Al revisar un país, revisa también la lista de nombres.**

**Se descarga solo lo que se abre.** Al abrir un país se baja únicamente su primer nivel (`geo/<ISO>/adm1.json`), y al abrir un departamento, solo sus ciudades (`geo/<ISO>/c/<departamento>.json`). Brasil tiene 5.570 municipios y España 8.205: mandarlos todos al abrir el país no es una opción. Para mostrar "3 de 153 municipios" no hace falta bajar los polígonos: el total viene en `countries.json` y lo visitado se cuenta por los prefijos de los ids.

Los nombres en el mapa salen del punto más interior de cada polígono (`lx`/`ly`, calculado en el build), no del centroide: en una forma de media luna, el centroide cae afuera.

La búsqueda usa `geo/search.json` (solo nombres, 2.7 MB sin comprimir), que se baja la primera vez que se escribe en el buscador y no al abrir la app.

## Estilo

- **El globo** en la vista del mundo (proyección `globe` de MapLibre), con una atmósfera que se desvanece al acercarse.
- **Tres mapas de fondo** más uno automático: *Claro* (Positron), *Oscuro* (Dark) y *Colorido* (Liberty). El automático sigue al tema del sistema. **La interfaz sigue al mapa**: con un fondo oscuro, el panel también es oscuro.
- Claro y Oscuro se **tiñen con los colores de la app** (tierra y agua en `--map-land` y `--map-water`). Colorido trae sus propios colores y no se toca.
- **El coral es lo único que llama la atención**: lo visitado en el mapa y el progreso en el panel. La tierra y el agua son frías y calmadas a propósito.
- Panel translúcido (`backdrop-filter`), que va abajo en el teléfono y a la izquierda en pantalla grande.

## Desarrollo local

```bash
npm install
npm run dev            # http://localhost:3100
```

`scripts/dev.mjs` aplica las mismas cabeceras de `vercel.json`, así que si algo choca con la CSP falla en local igual que fallaría en producción.

---

## Decisiones tomadas

### Lugar ≠ visita

Granada es un **lugar**. Ir a Granada en 2019 y en 2025 son dos **visitas**, cada una con su relato y sus fotos. Si se mezclaran, la ficha de Granada terminaría siendo un solo texto enorme. Las visitas se pueden agrupar en un **viaje** ("Norte de Nicaragua, Semana Santa"), que se lee como una línea de tiempo.

### Privado por defecto, compartir por recuerdo

La app es pública: cualquiera crea su cuenta. Pero cada visita es **privada** hasta que su autor decide otra cosa, y lo que se comparte es **una visita o un viaje**, nunca el mapa completo. Los niveles son:

| Nivel | Quién lo ve |
|---|---|
| Solo yo | El autor (es el valor por defecto) |
| Personas | Usuarios concretos de la app, invitados por su nombre de usuario |
| Con enlace | Cualquiera que tenga el enlace (no listado, revocable, con vencimiento opcional) |

- **Sin perfiles públicos ni buscador de personas**, por ahora. Un muro público obliga a moderar contenido, y eso es otro producto.
- Los permisos se revisan en el servidor, como en `deudas`: quien no tiene acceso recibe un **404 y no un 403**.
- **Las fotos se sirven con URL firmada y que vence**. Si un enlace a una foto se filtra, muere solo.
- Compartir **avisa si las fotos traen GPS**: el lugar exacto de una foto es un dato sensible.
- **Compañeros de viaje** (fase 3): se etiqueta a alguien que tiene cuenta. El viaje aparece también en su mapa y puede agregar sus propias fotos, pero no edita el relato de otro.

### Fotos en Cloudflare Images

- **Subida directa** (*Direct Creator Upload*): el servidor pide una URL de un solo uso y el teléfono sube la foto directo a Cloudflare. Así la foto no pasa por la función de Vercel, que tiene un límite de cuerpo de 4.5 MB.
- **Variantes en Cloudflare** (`thumb`, `card`, `full`): se sube una sola foto (achicada en el teléfono a ~2560 px) y Cloudflare entrega cada tamaño.
- `requireSignedURLs: true` en todas las fotos.
- La fecha y el GPS se leen del EXIF **en el teléfono, antes de subir**, porque Cloudflare quita los metadatos.
- **Cupo por usuario**: las 100.000 imágenes de la cuenta se comparten entre todos los usuarios. Si alguien sube 20.000 fotos, se acaba el cupo para el resto.
- Al borrar una cuenta o una visita se borran sus fotos en Cloudflare.

### Editor por bloques

Los bloques son párrafo, título, lista, enlace, **dirección (que es un pin en el mapa)**, foto de la galería y cita. Se guardan como **JSON, nunca como HTML**, para que mostrar una visita compartida no abra la puerta a XSS. El candidato es Editor.js, copiado en `vendor/`.

---

## Plan

| Fase | Qué sale |
|---|---|
| **0. Prueba técnica** ✅ | Mapa con el recorrido de Nicaragua, búsqueda y marcar como visitado en el navegador |
| **1. Lo mínimo usable** | Cuentas (la autenticación de `deudas` más confirmación por correo), visitas con texto simple, galería con Cloudflare Images y lo visitado guardado en Turso |
| **2. Contenido** | Editor por bloques, pines de lugares, fecha y lugar sugeridos a partir de la foto, más países |
| **3. Viajes y compartir** | Viajes como línea de tiempo, compartir con personas y con enlace, compañeros de viaje, capa **"quiero ir"**, estadísticas (países, km, días viajando) |
| **4. Pulido** | **Escribir sin señal** (borrador en el teléfono que se sube al volver la conexión), **exportar un viaje a PDF** (con `MiniPdf` de `deudas`), PWA instalable y app Flutter con la misma API |

### Pendientes de la fase 0

- **Recortar los lagos**: geoBoundaries reparte el Lago Cocibolca entre los municipios con líneas rectas. Por eso Granada se ve medio lago y el zoom queda más abierto de lo necesario. Se arregla restando la capa de lagos de Natural Earth en `build-geo.mjs`.
- **Archivos pesados**: el `adm1.json` de Canadá pesa 4.2 MB por las islas del Ártico, y el de Rusia 2.3 MB. Hace falta simplificar más cuando el resultado pasa de ~1 MB.
- **Conteos de países grandes**: no calzan exactos con los oficiales (São Paulo 639 contra 645, Minas Gerais 860 contra 853). Parte viene de la fuente y parte de municipios de borde que se asignan al estado vecino por superficie.
- **43 territorios sin divisiones** (Puerto Rico, Hong Kong, Groenlandia, entre otros): se marcan enteros. 21 países tienen primer nivel pero no ciudades (Andorra, Malta, Trinidad y Tobago…): ahí el departamento es el último nivel.
- **Nombres en inglés o sin tilde** en muchos países: solo están corregidos Nicaragua y los estados de Brasil.
- **España** va de comunidad a municipio, sin pasar por la provincia. Hay que decidir si conviene agregar un nivel intermedio.
- **Una lista de 779 municipios** (Andalucía) necesita un filtro en el panel.
- El estilo de fondo pide un icono `circle-11` que no viene en su sprite. Es solo un aviso en consola.
