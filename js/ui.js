// Piezas de interfaz compartidas. Nada de alert/confirm del navegador: bloquean
// la pagina, no se pueden estilar y en el telefono parecen un error.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Aviso corto abajo de la pantalla. kind: 'ok' | 'err'.
export function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = text;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 4500 : 2500);
}

// Ventana modal propia. content: HTML. Devuelve { root, close }.
// onClose se llama al cerrar por cualquier camino (boton, Escape, fondo).
export function modal(content, { onClose, label = 'Ventana' } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal glass-solid" role="dialog" aria-modal="true" aria-label="${esc(label)}">${content}</div>`;
  document.body.append(back);
  const root = back.firstElementChild;
  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.remove('show');
    removeEventListener('keydown', onKey);
    setTimeout(() => back.remove(), 200);
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  requestAnimationFrame(() => {
    back.classList.add('show');
    root.querySelector('[autofocus], input, button')?.focus();
  });
  return { root, close };
}

// Confirmacion: await ask({ title, text, ok: 'Borrar', danger: true }) -> true/false.
export function ask({ title, text = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const { root, close } = modal(
      `<h2>${esc(title)}</h2>${text ? `<p class="note">${esc(text)}</p>` : ''}
       <div class="actions"><button class="secondary" data-close>${esc(cancel)}</button>
       <button class="${danger ? 'danger' : 'primary'}" data-ok autofocus>${esc(ok)}</button></div>`,
      { label: title, onClose: () => resolve(answer) },
    );
    root.querySelector('[data-ok]').addEventListener('click', () => {
      answer = true;
      close();
    });
  });
}

// Deshabilita el boton mientras corre la peticion: sin esto, un doble toque
// crea dos visitas.
export async function busy(button, fn) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

// "17 abr 2025" / "17–20 abr 2025" / "30 abr – 2 may 2025".
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function formatRange(start, end) {
  if (!start) return 'Sin fecha';
  const [y1, m1, d1] = start.split('-').map(Number);
  if (!end || end === start) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  const [y2, m2, d2] = end.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y1}`;
  return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

// Texto del relato a parrafos. Se escapa todo: el texto lo escribe el usuario.
export const paragraphs = (body) =>
  (body ?? '')
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
