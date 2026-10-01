// Lugares puntuales de una visita: tipos, el formulario y la ficha.
// Los tipos son los mismos que PIN_KINDS en api/_lib/db.js.

import { modal, esc, busy } from './ui.js';
import { api } from './api.js';

// El color de cada tipo en el mapa. El emoji solo va en el panel y en la ficha:
// las fuentes del mapa (glifos de MapLibre) no tienen emoji.
export const KINDS = {
  see: { label: 'Ver', emoji: '👀', color: '#3b82f6' },
  eat: { label: 'Comer', emoji: '🍽️', color: '#f59e0b' },
  sleep: { label: 'Dormir', emoji: '🛏️', color: '#8b5cf6' },
  do: { label: 'Hacer', emoji: '🎒', color: '#10b981' },
  other: { label: 'Otro', emoji: '📍', color: '#64748b' },
};
export const kindOf = (k) => KINDS[k] ?? KINDS.other;

export const toGeoJSON = (pins) => ({
  type: 'FeatureCollection',
  features: pins.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: { id: p.id, name: p.name, kind: p.kind, visitId: p.visitId },
  })),
});

// Formulario de un lugar. Con pin: editarlo. Devuelve el pin guardado, o null si se cancela.
export function pinForm({ visitId, lat, lng, pin = null, name = '' }) {
  return new Promise((resolve) => {
    let saved = null;
    const k = pin?.kind ?? 'see';
    const { root, close } = modal(
      `<h2>${pin ? 'Editar lugar' : 'Nuevo lugar'}</h2>
       <form data-pin-form>
         <label class="field"><span>Nombre</span><input name="name" maxlength="120" required autofocus value="${esc(pin?.name ?? name)}" placeholder="Convento San Francisco"></label>
         <div class="field"><span>Tipo</span><div class="chips" role="radiogroup">
           ${Object.entries(KINDS)
             .map(([key, v]) => `<label class="chip"><input type="radio" name="kind" value="${key}" ${key === k ? 'checked' : ''}><span>${v.emoji} ${esc(v.label)}</span></label>`)
             .join('')}
         </div></div>
         <label class="field"><span>Nota (opcional)</span><textarea name="note" rows="3" maxlength="1000" placeholder="Qué hiciste, qué pediste, a qué hora conviene ir…">${esc(pin?.note ?? '')}</textarea></label>
         <p class="note coords">📍 ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}</p>
         <p class="form-error" hidden></p>
         <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button class="primary">${pin ? 'Guardar' : 'Agregar lugar'}</button></div>
       </form>`,
      { label: pin ? 'Editar lugar' : 'Nuevo lugar', onClose: () => resolve(saved) },
    );
    root.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = { ...Object.fromEntries(new FormData(form)), lat, lng };
      const err = form.querySelector('.form-error');
      err.hidden = true;
      await busy(form.querySelector('button.primary'), async () => {
        try {
          saved = pin
            ? (await api('pins', { method: 'PUT', query: { id: pin.id }, body: data })).pin
            : (await api('pins', { method: 'POST', body: { ...data, visitId } })).pin;
          close();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      });
    });
  });
}

// Ficha que aparece al tocar un pin en el mapa.
// inVisit: si ya se esta viendo su visita (entonces se puede editar ahi mismo).
export function pinCard(pin, { inVisit }) {
  const k = kindOf(pin.kind);
  return `<div class="pin-card">
    <span class="pin-kind" style="--k:${k.color}">${k.emoji} ${esc(k.label)}</span>
    <strong>${esc(pin.name)}</strong>
    ${pin.note ? `<p>${esc(pin.note)}</p>` : ''}
    ${inVisit
      ? `<div class="pin-actions"><button class="link" data-pin-edit="${pin.id}">Editar</button><button class="link" data-pin-move="${pin.id}">Mover</button><button class="danger-link" data-pin-delete="${pin.id}">Borrar</button></div>`
      : pin.visitTitle ? `<button class="link" data-go="${esc(pin.placeId)}/v/${pin.visitId}">${esc(pin.visitTitle)} →</button>` : ''}
  </div>`;
}
