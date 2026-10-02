// Mostrar un relato: los bloques del editor a HTML para leer.
//
// El servidor ya limpio el texto (api/_lib/story.js), pero aqui se vuelve a
// limpiar: el relato publicado lo escribe otra persona, y no se confia en que
// lo que llega por la red sea lo que se guardo.

import { esc } from './ui.js';
import { kindOf } from './pins.js';

const INLINE = new Set(['B', 'I', 'MARK', 'A', 'BR', 'CODE', 'U', 'S', 'SPAN']);
// Los colores del texto y del resaltado: los mismos de api/_lib/story.js.
export const COLORS = ['coral', 'amber', 'green', 'blue', 'violet'];

// Reconstruye el texto con solo las etiquetas permitidas. El navegador parsea
// (un <template> no ejecuta nada) y se vuelve a armar desde cero.
export function safeInline(html) {
  const t = document.createElement('template');
  t.innerHTML = html ?? '';
  const walk = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += esc(n.textContent);
      else if (n.nodeType === 1) {
        const tag = n.tagName === 'STRONG' ? 'B' : n.tagName === 'EM' ? 'I' : n.tagName;
        if (!INLINE.has(tag)) {
          out += walk(n);
          continue;
        }
        if (tag === 'BR') {
          out += '<br>';
          continue;
        }
        if (tag === 'A') {
          const href = n.getAttribute('href') ?? '';
          out += /^(https?:\/\/|mailto:)/i.test(href)
            ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${walk(n)}</a>`
            : walk(n);
          continue;
        }
        const c = n.getAttribute('data-color');
        if (tag === 'SPAN') {
          out += COLORS.includes(c) ? `<span data-color="${c}">${walk(n)}</span>` : walk(n);
          continue;
        }
        if (tag === 'MARK' && COLORS.includes(c)) {
          out += `<mark data-color="${c}">${walk(n)}</mark>`;
          continue;
        }
        const t2 = tag.toLowerCase();
        out += `<${t2}>${walk(n)}</${t2}>`;
      }
    }
    return out;
  };
  return walk(t.content);
}

function listHtml(style, items) {
  const tag = style === 'ordered' ? 'ol' : 'ul';
  return `<${tag} class="${style === 'checklist' ? 'checklist' : ''}">${items
    .map((it) => {
      const check = style === 'checklist' ? `<span class="check ${it.meta?.checked ? 'on' : ''}" aria-label="${it.meta?.checked ? 'hecho' : 'pendiente'}"></span>` : '';
      return `<li>${check}<span>${safeInline(it.content)}</span>${it.items?.length ? listHtml(style, it.items) : ''}</li>`;
    })
    .join('')}</${tag}>`;
}

const center = (d) => (d.align === 'center' ? ' class="is-center"' : '');

// ctx.photos: Map id -> foto (con urls); ctx.pins: Map id -> pin.
// Una foto o un lugar que ya no estan (se borraron) simplemente no se muestran.
export function renderStory(doc, { photos = new Map(), pins = new Map() } = {}) {
  if (!doc?.blocks?.length) return '';
  return doc.blocks
    .map(({ type, data: d }) => {
      switch (type) {
        case 'paragraph':
          return `<p${center(d)}>${safeInline(d.text)}</p>`;
        case 'header':
          return d.level === 3 ? `<h4${center(d)}>${safeInline(d.text)}</h4>` : `<h3${center(d)}>${safeInline(d.text)}</h3>`;
        case 'list':
          return listHtml(d.style, d.items ?? []);
        case 'quote':
          return `<blockquote${center(d)}><p>${safeInline(d.text)}</p>${d.caption ? `<cite>${safeInline(d.caption)}</cite>` : ''}</blockquote>`;
        case 'delimiter':
          return '<hr class="delimiter">';
        case 'callout':
          return `<aside class="callout"><span class="callout-emoji" aria-hidden="true">${esc(d.emoji)}</span><div>${safeInline(d.text)}</div></aside>`;
        case 'photo': {
          const p = photos.get(d.photoId);
          if (!p) return '';
          return `<figure class="story-photo ${d.wide ? 'wide' : ''}"><button class="story-photo-btn" data-story-photo="${p.id}"><img src="${esc(d.wide ? p.urls.full : p.urls.card)}" alt="${esc(d.caption ? '' : p.caption ?? '')}" loading="lazy"></button>${d.caption ? `<figcaption>${safeInline(d.caption)}</figcaption>` : ''}</figure>`;
        }
        case 'place': {
          const pin = pins.get(d.pinId);
          if (!pin) return '';
          const k = kindOf(pin.kind);
          return `<button class="story-place" data-pin-focus="${pin.id}" style="--k:${k.color}"><span class="pin-emoji">${k.emoji}</span><span><b>${esc(pin.name)}</b>${pin.note ? `<small>${esc(pin.note)}</small>` : ''}</span><span class="story-place-go" aria-hidden="true">Ver en el mapa →</span></button>`;
        }
        default:
          return '';
      }
    })
    .join('');
}
