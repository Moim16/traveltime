// El relato de una visita: bloques del editor (Editor.js), guardados como JSON.
//
// Lo que se acepta se decide aqui, no en el navegador: el relato publicado lo
// lee cualquiera, y un bloque o una etiqueta que no esten en la lista se descartan.
// El navegador vuelve a limpiar al mostrar (js/story.js); son dos cercos.
//
//   { v: 1, blocks: [{ type, data }] }
//
// Un relato viejo (texto plano de la fase 1) se lee como parrafos.

const MAX_BLOCKS = 400;
const MAX_TEXT = 4000; // por bloque
const MAX_JSON = 300_000;

// Etiquetas que puede llevar el texto de un bloque: lo que ofrece la barra al
// seleccionar texto. Nada de atributos salvo el href de un enlace y el color
// (data-color) de un span (color del texto) o de un mark (resaltado), y solo
// de la lista: asi se leen bien en tema claro y oscuro (los pinta el CSS).
const INLINE = new Set(['b', 'strong', 'i', 'em', 'mark', 'a', 'br', 'code', 'u', 's', 'span']);
export const COLORS = ['coral', 'amber', 'green', 'blue', 'violet'];
const colorOf = (attrs) => {
  const c = (attrs.match(/data-color\s*=\s*"([^"]*)"/i) ?? attrs.match(/data-color\s*=\s*'([^']*)'/i) ?? [])[1];
  return COLORS.includes(c) ? c : null;
};

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function safeHref(href) {
  const h = (href ?? '').trim().replace(/&amp;/g, '&');
  return /^(https?:\/\/|mailto:)/i.test(h) && h.length <= 2000 ? h : null;
}

// Deja solo las etiquetas permitidas. Todo lo demas se borra (la etiqueta, no
// su texto). Un "<" suelto que no es etiqueta se escapa.
export function sanitizeInline(html) {
  const s = (html ?? '').toString().slice(0, MAX_TEXT * 2);
  let out = '';
  let last = 0;
  const open = [];
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g)) {
    out += escapeStray(s.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    // strong y em se guardan como b e i, tambien al cerrar (si no, la negrita se
    // abria como <b> y su </strong> no encontraba que cerrar).
    const raw = m[2].toLowerCase();
    const tag = raw === 'strong' ? 'b' : raw === 'em' ? 'i' : raw;
    if (!INLINE.has(tag)) continue;
    if (tag === 'br') {
      if (!closing) out += '<br>';
      continue;
    }
    if (closing) {
      const i = open.lastIndexOf(tag);
      if (i === -1) continue;
      // Cerrar tambien lo que quedo abierto adentro, para que el HTML no se descuadre.
      while (open.length > i) out += `</${open.pop()}>`;
      continue;
    }
    if (tag === 'a') {
      const href = safeHref((m[3].match(/href\s*=\s*"([^"]*)"/i) ?? m[3].match(/href\s*=\s*'([^']*)'/i) ?? [])[1]);
      if (!href) continue;
      out += `<a href="${escapeHtml(href).replace(/"/g, '&quot;')}">`;
    } else if (tag === 'span') {
      // Un span sin color de la lista no aporta nada: se va (su texto queda).
      const c = colorOf(m[3]);
      if (!c) continue;
      out += `<span data-color="${c}">`;
    } else if (tag === 'mark') {
      const c = colorOf(m[3]);
      out += c && c !== 'amber' ? `<mark data-color="${c}">` : '<mark>';
    } else {
      out += `<${tag}>`;
    }
    open.push(tag);
  }
  out += escapeStray(s.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out.slice(0, MAX_TEXT * 2);
}
// Las entidades (&amp; &nbsp;) se respetan; un < o > suelto se escapa.
const escapeStray = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = (v) => sanitizeInline(v).trim();
const plain = (v, max) => (v ?? '').toString().replace(/[<>]/g, '').trim().slice(0, max);
const id = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function listItems(items, depth = 0) {
  if (!Array.isArray(items) || depth > 4) return [];
  return items.slice(0, 200).map((it) => ({
    content: text(typeof it === 'string' ? it : it?.content),
    meta: it?.meta?.checked !== undefined ? { checked: Boolean(it.meta.checked) } : {},
    items: listItems(it?.items, depth + 1),
  }));
}

// Cada tipo de bloque: como se limpia. Devuelve data, o null para descartar el bloque.
// Centrado: solo parrafo, titulo y cita, y solo "center" (a la izquierda es lo normal).
const align = (d) => (d.align === 'center' ? { align: 'center' } : {});

const BLOCKS = {
  paragraph: (d) => ({ text: text(d.text), ...align(d) }),
  header: (d) => (text(d.text) ? { text: text(d.text), level: d.level === 3 ? 3 : 2, ...align(d) } : null),
  list: (d) => {
    const items = listItems(d.items);
    return items.length ? { style: ['ordered', 'checklist'].includes(d.style) ? d.style : 'unordered', items } : null;
  },
  quote: (d) => (text(d.text) ? { text: text(d.text), caption: text(d.caption), ...align(d) } : null),
  delimiter: () => ({}),
  // Un aviso con icono: "💡 Llevar efectivo, no aceptan tarjeta".
  callout: (d) => (text(d.text) ? { emoji: plain(d.emoji, 8) || '💡', text: text(d.text) } : null),
  // Una foto de la galeria de la visita. Se guarda el id, no la URL: las URL vencen.
  photo: (d) => (id(d.photoId) ? { photoId: id(d.photoId), caption: text(d.caption), wide: Boolean(d.wide) } : null),
  // Un lugar (pin) de la visita: se muestra como tarjeta y lleva al mapa.
  place: (d) => (id(d.pinId) ? { pinId: id(d.pinId) } : null),
};

// body puede venir como objeto { blocks } (el editor), como texto (la fase 1 o
// un cliente viejo) o vacio. Devuelve { ok, value: string|null } listo para guardar.
export function parseStory(body) {
  if (body === null || body === undefined || body === '') return { ok: true, value: null };
  if (typeof body === 'string') {
    const doc = fromPlainText(body);
    return { ok: true, value: doc.blocks.length ? JSON.stringify(doc) : null };
  }
  if (typeof body !== 'object' || !Array.isArray(body.blocks)) return { ok: false, error: 'El relato no tiene un formato válido.' };
  if (body.blocks.length > MAX_BLOCKS) return { ok: false, error: `El relato puede tener hasta ${MAX_BLOCKS} bloques.` };
  const blocks = [];
  for (const b of body.blocks) {
    const clean = BLOCKS[b?.type]?.(b.data ?? {});
    if (!clean) continue;
    if (b.type === 'paragraph' && !clean.text) continue; // parrafos vacios: el editor los deja al apretar Enter
    blocks.push({ type: b.type, data: clean });
  }
  if (!blocks.length) return { ok: true, value: null };
  const json = JSON.stringify({ v: 1, blocks });
  if (json.length > MAX_JSON) return { ok: false, error: 'El relato es demasiado largo.' };
  return { ok: true, value: json };
}

export function fromPlainText(s) {
  const paras = (s ?? '').toString().replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return { v: 1, blocks: paras.map((p) => ({ type: 'paragraph', data: { text: escapeHtml(p).replace(/\n/g, '<br>') } })) };
}

// Lo guardado -> { v, blocks }. Lo que no es JSON es un relato de la fase 1.
export function readStory(stored) {
  if (!stored) return null;
  if (stored.startsWith('{')) {
    try {
      const doc = JSON.parse(stored);
      if (Array.isArray(doc.blocks)) return doc;
    } catch {}
  }
  return fromPlainText(stored);
}

// Un resumen en texto plano: para las tarjetas de la pagina de inicio.
export function excerpt(doc, max = 220) {
  const strip = (h) => (h ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  let out = '';
  for (const b of doc?.blocks ?? []) {
    const t = strip(b.data?.text);
    if (t && ['paragraph', 'quote', 'callout'].includes(b.type)) out += (out ? ' ' : '') + t;
    if (out.length >= max) break;
  }
  return out.length > max ? out.slice(0, max).replace(/\s+\S*$/, '') + '…' : out;
}

// Las fotos y los lugares que el relato menciona: para traer solo esos al mostrarlo.
export function references(doc) {
  const photos = new Set();
  const pins = new Set();
  for (const b of doc?.blocks ?? []) {
    if (b.type === 'photo') photos.add(b.data.photoId);
    if (b.type === 'place') pins.add(b.data.pinId);
  }
  return { photos: [...photos], pins: [...pins] };
}
