// "Escríbelo por mí": Claude escribe un borrador del relato de una visita con lo
// que hay de ella (fotos, que mira; lugares; fechas; notas de la persona). La
// persona lo edita despues: es un punto de partida, no el relato final.
//
// Se le pide la respuesta por una herramienta con esquema fijo (tool_choice), asi
// vuelve como bloques del editor y no como texto libre. Despues pasa por la misma
// limpieza que cualquier relato (api/_lib/story.js parseStory).
//
// Necesita ANTHROPIC_API_KEY. ANTHROPIC_MODEL cambia el modelo.

// ANTHROPIC_BASE_URL: solo para probar contra un Claude de mentira local.
const API = `${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`;
export const aiReady = () => Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

/** Cuantos borradores por persona por dia: cada uno cuesta (fotos incluidas). */
export const DRAFTS_PER_DAY = 15;
/** Fotos que mira como mucho (las primeras de la galeria). */
export const MAX_PHOTOS = 10;

export const TONES = {
  cercano: 'cercano y personal, como contándole a un amigo, con emoción pero sin exagerar',
  guia: 'práctico, como una guía para quien quiera ir: qué ver, cuánto tiempo, consejos concretos',
  poetico: 'evocador y sensorial: luz, olores, sonidos; frases con ritmo, sin cursilería',
};

const TOOL = {
  name: 'escribir_relato',
  description: 'Entrega el relato de la visita como bloques del editor.',
  input_schema: {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        description: 'El relato, en orden. Entre 4 y 14 bloques.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['paragraph', 'header', 'list', 'quote', 'callout', 'photo', 'place'] },
            text: { type: 'string', description: 'paragraph, header, quote, callout. Puede llevar <b>, <i>.' },
            level: { type: 'integer', enum: [2, 3], description: 'header: 2 titulo, 3 subtitulo' },
            style: { type: 'string', enum: ['unordered', 'ordered', 'checklist'], description: 'list' },
            items: { type: 'array', items: { type: 'string' }, description: 'list' },
            emoji: { type: 'string', description: 'callout: un emoji' },
            photoId: { type: 'integer', description: 'photo: el id de una de las fotos dadas' },
            caption: { type: 'string', description: 'photo: pie de foto corto' },
            pinId: { type: 'integer', description: 'place: el id de uno de los lugares dados' },
          },
          required: ['type'],
        },
      },
    },
    required: ['blocks'],
  },
};

const SYSTEM = `Eres quien ayuda a escribir un diario de viaje en primera persona, en español latinoamericano neutro.
Escribes el relato de UNA visita a partir de lo que la persona registró: el lugar, las fechas, sus fotos (que puedes mirar), los lugares que marcó en el mapa y sus notas.

Reglas:
- Primera persona ("llegué", "comimos"). Es SU viaje: no inventes personas, nombres, precios, horarios ni anécdotas que no estén en los datos o en las fotos. Si algo no se sabe, no lo afirmes: describe lo que se ve en las fotos y lo que dicen las notas.
- Usa las fotos: inserta bloques "photo" con su photoId donde encajen, con un pie de foto corto que describa lo que se ve. No repitas una foto.
- Usa los lugares marcados: un bloque "place" con su pinId cuando hables de ese sitio.
- Un título (header nivel 2) al principio, corto y con gancho. Párrafos de 2 a 4 frases.
- Si hay datos prácticos (notas de lugares, cosas útiles), un "callout" con emoji o una lista.
- Nada de hashtags, ni de cerrar con moralejas genéricas.
Entrega el relato SOLO con la herramienta escribir_relato.`;

const fmtDay = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null);

/** El mensaje para Claude: los datos en texto, y las fotos como imagenes. */
export function buildPrompt({ visit, photos, pins, trip, notes, tone }) {
  const when = visit.startDay
    ? visit.endDay && visit.endDay !== visit.startDay
      ? `del ${fmtDay(visit.startDay)} al ${fmtDay(visit.endDay)}`
      : `el ${fmtDay(visit.startDay)}`
    : 'sin fecha';
  const lines = [
    `Lugar: ${visit.placeName ?? visit.placeId}`,
    `Título que le puso: ${visit.title}`,
    `Cuándo: ${when}`,
    trip ? `Es parte del viaje «${trip}».` : null,
    pins.length
      ? `Lugares que marcó en el mapa:\n${pins.map((p) => `- [pinId ${p.id}] ${p.name} (${p.kind})${p.note ? `: ${p.note}` : ''}`).join('\n')}`
      : 'No marcó lugares puntuales.',
    photos.length
      ? `Fotos (en orden; cada imagen va precedida de su photoId):\n${photos.map((p) => `- [photoId ${p.id}]${p.takenAt ? ` tomada ${p.takenAt.replace('T', ' a las ').slice(0, 21)}` : ''}${p.caption ? ` · pie: ${p.caption}` : ''}`).join('\n')}`
      : 'No subió fotos.',
    notes ? `Lo que la persona quiere que diga:\n${notes}` : null,
    `Tono: ${TONES[tone] ?? TONES.cercano}.`,
  ].filter(Boolean);
  const content = [{ type: 'text', text: lines.join('\n\n') }];
  for (const p of photos) {
    content.push({ type: 'text', text: `photoId ${p.id}:` });
    content.push({ type: 'image', source: { type: 'url', url: p.url } });
  }
  return content;
}

/** Los bloques que devuelve Claude -> los del editor (Editor.js). */
export function toEditorBlocks(raw, { photoIds, pinIds }) {
  const out = [];
  const usedPhotos = new Set();
  for (const b of Array.isArray(raw) ? raw : []) {
    switch (b?.type) {
      case 'paragraph':
        if (b.text) out.push({ type: 'paragraph', data: { text: String(b.text) } });
        break;
      case 'header':
        if (b.text) out.push({ type: 'header', data: { text: String(b.text), level: b.level === 3 ? 3 : 2 } });
        break;
      case 'quote':
        if (b.text) out.push({ type: 'quote', data: { text: String(b.text), caption: '' } });
        break;
      case 'callout':
        if (b.text) out.push({ type: 'callout', data: { emoji: String(b.emoji ?? '💡').slice(0, 8), text: String(b.text) } });
        break;
      case 'list':
        if (Array.isArray(b.items) && b.items.length) {
          out.push({
            type: 'list',
            data: {
              style: ['ordered', 'checklist'].includes(b.style) ? b.style : 'unordered',
              items: b.items.map((t) => ({ content: String(t), meta: b.style === 'checklist' ? { checked: false } : {}, items: [] })),
            },
          });
        }
        break;
      case 'photo':
        // Solo fotos de esta visita, y cada una una vez.
        if (photoIds.has(b.photoId) && !usedPhotos.has(b.photoId)) {
          usedPhotos.add(b.photoId);
          out.push({ type: 'photo', data: { photoId: b.photoId, caption: String(b.caption ?? ''), wide: false } });
        }
        break;
      case 'place':
        if (pinIds.has(b.pinId)) out.push({ type: 'place', data: { pinId: b.pinId } });
        break;
    }
  }
  return out;
}

/** Llama a Claude. Devuelve los bloques crudos (sin limpiar) o lanza Error. */
export async function draftStory(content) {
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL(),
      max_tokens: 3000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error?.message ?? `Claude respondió ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const use = (j.content ?? []).find((c) => c.type === 'tool_use' && c.name === TOOL.name);
  if (!use) throw new Error('Claude no entregó el relato.');
  return use.input?.blocks ?? [];
}
