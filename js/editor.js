// Modo escritura: el relato de una visita como un post de blog.
//
// Pantalla completa (en el panel lateral no se escribe a gusto), con Editor.js:
// bloques que se agregan con "+" o escribiendo "/", y una barra al seleccionar
// texto (negrita, cursiva, resaltado, enlace). Ademas de los bloques de
// Editor.js hay tres propios: aviso, foto y lugar.
//
// Editor.js pesa ~500 KB: se carga la primera vez que se abre, no con la app.

import { esc, toast, ask, modal as openModal } from './ui.js';
import { kindOf } from './pins.js';
import { ColorTool, AlignTune, toEditor, fromEditor } from './editor-tools.js';
import { api } from './api.js';

const V = '/vendor/editorjs';
let libs = null;
const loadLibs = () =>
  (libs ??= Promise.all(
    ['editorjs', 'header', 'list', 'quote', 'delimiter'].map((m) => import(`${V}/${m}.mjs`).then((x) => x.default)),
  ));

const ICON = {
  callout: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
  photo: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="m21 15-5-5L5 21"/></svg>',
  place: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
};

const EMOJIS = ['💡', '⚠️', '❤️', '⭐', '📌', '🗺️', '🍽️', '☕', '🏨', '🚌', '✈️', '🚗', '💰', '🎒', '📸', '🌋', '🏖️', '⛰️', '🌧️', '☀️', '🎉', '🙏', '😋', '🤩'];

// Las etiquetas que el editor deja en el texto de los bloques propios (Editor.js
// limpia con esta lista al pegar y al guardar).
const INLINE_SANITIZE = { b: true, i: true, a: { href: true }, mark: true, br: true, code: true };

// ---------- Bloque: aviso ----------

class CalloutTool {
  static get toolbox() {
    return { title: 'Aviso', icon: ICON.callout };
  }
  static get sanitize() {
    return { text: INLINE_SANITIZE };
  }
  constructor({ data }) {
    this.data = { emoji: data.emoji || '💡', text: data.text || '' };
  }
  render() {
    const el = document.createElement('div');
    el.className = 'tt-callout';
    el.innerHTML = `<button type="button" class="tt-callout-emoji" title="Cambiar ícono">${esc(this.data.emoji)}</button>
      <div class="tt-callout-text" contenteditable="true" data-placeholder="Un dato útil: horarios, precios, qué llevar…"></div>
      <div class="tt-emoji-grid" hidden>${EMOJIS.map((e) => `<button type="button">${e}</button>`).join('')}</div>`;
    el.querySelector('.tt-callout-text').innerHTML = this.data.text;
    const grid = el.querySelector('.tt-emoji-grid');
    el.querySelector('.tt-callout-emoji').addEventListener('click', () => (grid.hidden = !grid.hidden));
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.data.emoji = b.textContent;
      el.querySelector('.tt-callout-emoji').textContent = b.textContent;
      grid.hidden = true;
    });
    return el;
  }
  save(el) {
    return { emoji: this.data.emoji, text: el.querySelector('.tt-callout-text').innerHTML };
  }
}

// ---------- Bloque: foto ----------
// config: { photos(): [foto], upload(file) -> foto }

class PhotoTool {
  static get toolbox() {
    return { title: 'Foto', icon: ICON.photo };
  }
  static get sanitize() {
    return { caption: INLINE_SANITIZE };
  }
  constructor({ data, config }) {
    this.data = { photoId: data.photoId ?? null, caption: data.caption ?? '', wide: Boolean(data.wide) };
    this.config = config;
    this.el = document.createElement('div');
    this.el.className = 'tt-photo';
  }
  render() {
    this.paint();
    return this.el;
  }
  paint() {
    const p = this.data.photoId && this.config.photos().find((x) => x.id === this.data.photoId);
    if (p) {
      this.el.innerHTML = `<figure class="${this.data.wide ? 'wide' : ''}"><img src="${esc(this.data.wide ? p.urls.full : p.urls.card)}" alt="">
        <figcaption contenteditable="true" data-placeholder="Pie de foto (opcional)"></figcaption></figure>
        <div class="tt-photo-tools"><button type="button" data-wide>${this.data.wide ? 'Tamaño normal' : 'Ancho completo'}</button><button type="button" data-change>Cambiar foto</button></div>`;
      this.el.querySelector('figcaption').innerHTML = this.data.caption;
      this.el.querySelector('[data-wide]').addEventListener('click', () => {
        this.data.caption = this.el.querySelector('figcaption').innerHTML;
        this.data.wide = !this.data.wide;
        this.paint();
      });
      this.el.querySelector('[data-change]').addEventListener('click', () => {
        this.data.caption = this.el.querySelector('figcaption').innerHTML;
        this.data.photoId = null;
        this.paint();
      });
      return;
    }
    const photos = this.config.photos();
    this.el.innerHTML = `<div class="tt-picker">
      <p>Elige una foto de la visita o sube una nueva</p>
      <div class="tt-picker-grid">${photos.map((x) => `<button type="button" data-pick="${x.id}"><img src="${esc(x.urls.thumb)}" alt="" loading="lazy"></button>`).join('')}
        <label class="tt-upload"><input type="file" accept="image/*" hidden><span>＋<br>Subir</span></label></div></div>`;
    this.el.querySelectorAll('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        this.data.photoId = Number(b.dataset.pick);
        this.paint();
      }),
    );
    this.el.querySelector('input[type=file]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const label = this.el.querySelector('.tt-upload span');
      label.textContent = 'Subiendo…';
      try {
        const photo = await this.config.upload(file);
        this.data.photoId = photo.id;
        this.paint();
      } catch (ex) {
        toast(ex.message, 'err');
        label.innerHTML = '＋<br>Subir';
      }
    });
  }
  save() {
    const cap = this.el.querySelector('figcaption');
    return { photoId: this.data.photoId, caption: cap ? cap.innerHTML : this.data.caption, wide: this.data.wide };
  }
  validate(data) {
    return Boolean(data.photoId); // un bloque sin foto elegida no se guarda
  }
}

// ---------- Bloque: lugar ----------
// config: { pins(): [pin], refresh(): Promise (vuelve a pedir los pines) }

class PlaceTool {
  static get toolbox() {
    return { title: 'Lugar', icon: ICON.place };
  }
  constructor({ data, config }) {
    this.data = { pinId: data.pinId ?? null };
    this.config = config;
    this.el = document.createElement('div');
    this.el.className = 'tt-place';
  }
  render() {
    this.paint();
    // La lista se pide de nuevo al abrir el selector: un lugar agregado con el
    // editor ya abierto (desde el mapa, otra pestaña) tiene que aparecer.
    if (!this.data.pinId) this.config.refresh?.().then(() => !this.data.pinId && this.paint());
    return this.el;
  }
  paint() {
    const pin = this.data.pinId && this.config.pins().find((p) => p.id === this.data.pinId);
    if (pin) {
      const k = kindOf(pin.kind);
      this.el.innerHTML = `<div class="story-place" style="--k:${k.color}"><span class="pin-emoji">${k.emoji}</span><span><b>${esc(pin.name)}</b>${pin.note ? `<small>${esc(pin.note)}</small>` : ''}</span><button type="button" class="link" data-change>Cambiar</button></div>`;
      this.el.querySelector('[data-change]').addEventListener('click', () => {
        this.data.pinId = null;
        this.paint();
      });
      return;
    }
    const pins = this.config.pins();
    this.el.innerHTML = pins.length
      ? `<div class="tt-picker"><p>¿Qué lugar de esta visita?</p><div class="tt-place-list">${pins
          .map((p) => `<button type="button" data-pick="${p.id}">${kindOf(p.kind).emoji} ${esc(p.name)}</button>`)
          .join('')}</div></div>`
      : `<div class="tt-picker"><p>Esta visita todavía no tiene lugares. Agrégalos desde la visita con <b>+ Lugar</b> (tocando el mapa) y luego insértalos aquí.</p></div>`;
    this.el.querySelectorAll('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        this.data.pinId = Number(b.dataset.pick);
        this.paint();
      }),
    );
  }
  save() {
    return { pinId: this.data.pinId };
  }
  validate(data) {
    return Boolean(data.pinId);
  }
}

// ---------- Textos de Editor.js en español ----------

const I18N = {
  messages: {
    ui: {
      blockTunes: { toggler: { 'Click to tune': 'Opciones', 'or drag to move': 'o arrastra para mover' } },
      inlineToolbar: { converter: { 'Convert to': 'Convertir en' } },
      toolbar: { toolbox: { Add: 'Agregar' } },
      popover: { Filter: 'Buscar', 'Nothing found': 'Nada', 'Convert to': 'Convertir en' },
    },
    toolNames: {
      Text: 'Texto', Heading: 'Título', 'Unordered List': 'Lista', 'Ordered List': 'Lista numerada', Checklist: 'Lista de tareas',
      List: 'Lista', Quote: 'Cita', Delimiter: 'Separador', Color: 'Color', Centrar: 'Centrar', Bold: 'Negrita', Italic: 'Cursiva', Link: 'Enlace',
      Aviso: 'Aviso', Foto: 'Foto', Lugar: 'Lugar',
    },
    tools: {
      link: { 'Add a link': 'Pega o escribe un enlace' },
      header: { 'Heading 2': 'Título', 'Heading 3': 'Subtítulo' },
      quote: { 'Enter a quote': 'Escribe la cita', 'Quote\'s author': 'Quién lo dijo' },
      list: { Unordered: 'Con viñetas', Ordered: 'Numerada', Checklist: 'De tareas' },
    },
    blockTunes: {
      delete: { Delete: 'Borrar', 'Click to delete': 'Confirmar' },
      moveUp: { 'Move up': 'Subir' },
      moveDown: { 'Move down': 'Bajar' },
    },
  },
};

// ---------- Borrador en el telefono ----------
// localStorage puede faltar (ventana privada, sin espacio): todo va en try y,
// si falla, simplemente no hay borrador.

const DRAFT_DELAY_MS = 1000;
const draftKey = (id) => `tt.draft.${id}`;
function writeDraft(id, data) {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify(data));
  } catch {}
}
function readDraft(id) {
  try {
    return JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
  } catch {
    return null;
  }
}
function dropDraft(id) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {}
}
function timeAgo(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `el ${new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' })}`;
}

// ---------- La pantalla ----------

let open = null;
export const isOpen = () => Boolean(open);

// visit: la visita (con body { blocks }). placeLabel: "Granada, Nicaragua".
// photos()/pins(): lo de la visita, vivo. upload(file) -> foto.
// save({ title, startDay, endDay, body }) -> visita guardada. onClose(): al salir.
export async function openWriter({ visit, placeLabel, photos, pins, refreshPins, upload, save, onClose }) {
  if (open) return;
  const today = new Date().toISOString().slice(0, 10);
  const root = document.createElement('div');
  root.className = 'writer';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Escribir la visita');
  root.innerHTML = `
    <header class="writer-bar">
      <button class="link" data-w-close>← Volver</button>
      <span class="writer-status" aria-live="polite"></span>
      <button class="secondary ai-btn" data-w-ai hidden>✨ Escríbelo por mí</button>
      <button class="primary" data-w-save>Guardar</button>
    </header>
    <div class="writer-scroll"><article class="writer-page">
      <p class="kind">${esc(placeLabel)}</p>
      <textarea class="writer-title" rows="1" maxlength="120" placeholder="Título de la visita">${esc(visit.title)}</textarea>
      <div class="writer-dates">
        <label>Desde <input type="date" name="startDay" max="${today}" value="${esc(visit.startDay ?? '')}"></label>
        <label>Hasta <input type="date" name="endDay" max="${today}" value="${esc(visit.endDay ?? '')}"></label>
      </div>
      <div class="writer-editor" id="writer-editor"><p class="note">Cargando el editor…</p></div>
    </article></div>`;
  document.body.append(root);
  document.body.classList.add('writing');
  requestAnimationFrame(() => root.classList.add('show'));

  const title = root.querySelector('.writer-title');
  const fit = () => {
    title.style.height = 'auto';
    title.style.height = `${title.scrollHeight}px`;
  };
  fit();
  const status = root.querySelector('.writer-status');
  let dirty = false;
  let editor = null;
  let draftTimer = null;
  const markDirty = () => {
    dirty = true;
    status.textContent = 'Sin guardar';
    // Borrador en el telefono, un segundo despues de dejar de escribir.
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, DRAFT_DELAY_MS);
  };
  const saveDraft = async () => {
    if (!editor || !dirty) return;
    try {
      const body = await editor.save();
      writeDraft(visit.id, {
        at: new Date().toISOString(),
        base: visit.updatedAt,
        title: title.value,
        startDay: root.querySelector('[name=startDay]').value,
        endDay: root.querySelector('[name=endDay]').value,
        blocks: body.blocks,
      });
    } catch {}
  };
  title.addEventListener('input', () => (fit(), markDirty()));
  root.querySelectorAll('.writer-dates input').forEach((i) => i.addEventListener('change', markDirty));

  const [EditorJS, Header, List, Quote, Delimiter] = await loadLibs();
  root.querySelector('#writer-editor').innerHTML = '';
  editor = new EditorJS({
    holder: 'writer-editor',
    data: { blocks: toEditor(visit.body?.blocks) },
    placeholder: 'Cuenta qué hiciste… Toca + para agregar títulos, fotos, lugares o avisos.',
    autofocus: !visit.body?.blocks?.length,
    i18n: I18N,
    inlineToolbar: ['bold', 'italic', 'color', 'link'],
    tools: {
      paragraph: { inlineToolbar: true, tunes: ['align'] },
      header: { class: Header, inlineToolbar: ['color', 'link'], tunes: ['align'], config: { levels: [2, 3], defaultLevel: 2, placeholder: 'Título' } },
      list: { class: List, inlineToolbar: true, config: { defaultStyle: 'unordered' } },
      quote: { class: Quote, inlineToolbar: true, tunes: ['align'] },
      align: AlignTune,
      callout: { class: CalloutTool, inlineToolbar: true },
      photo: { class: PhotoTool, config: { photos, upload } },
      place: { class: PlaceTool, config: { pins, refresh: refreshPins } },
      delimiter: Delimiter,
      color: ColorTool,
    },
    onChange: markDirty,
  });
  await editor.isReady;

  // Un borrador mas nuevo que lo guardado (se corto la señal, se cerro la
  // pestaña, se acabo la bateria): se ofrece, no se impone.
  const draft = readDraft(visit.id);
  if (draft && draft.base === visit.updatedAt) {
    const bar = document.createElement('div');
    bar.className = 'draft-bar';
    bar.innerHTML = `<span>📝 Tienes un borrador sin guardar de ${esc(timeAgo(draft.at))}.</span>
      <button class="primary small" data-draft-use>Recuperar</button><button class="link" data-draft-drop>Descartar</button>`;
    root.querySelector('.writer-page').prepend(bar);
    bar.querySelector('[data-draft-use]').addEventListener('click', async () => {
      title.value = draft.title;
      fit();
      root.querySelector('[name=startDay]').value = draft.startDay ?? '';
      root.querySelector('[name=endDay]').value = draft.endDay ?? '';
      await editor.render({ blocks: draft.blocks });
      bar.remove();
      markDirty();
      status.textContent = 'Borrador recuperado · sin guardar';
    });
    bar.querySelector('[data-draft-drop]').addEventListener('click', () => {
      dropDraft(visit.id);
      bar.remove();
    });
  } else if (draft) {
    // La visita cambio desde otro lado despues de ese borrador: ya no aplica.
    dropDraft(visit.id);
  }

  const doSave = async () => {
    const btn = root.querySelector('[data-w-save]');
    if (btn.disabled) return false;
    btn.disabled = true;
    status.textContent = 'Guardando…';
    try {
      const body = await editor.save();
      const saved = await save({
        title: title.value,
        startDay: root.querySelector('[name=startDay]').value,
        endDay: root.querySelector('[name=endDay]').value,
        body: { blocks: fromEditor(body.blocks) },
      });
      dirty = false;
      clearTimeout(draftTimer);
      dropDraft(visit.id);
      status.textContent = 'Guardado ✓';
      visit = saved;
      return true;
    } catch (ex) {
      // Sin señal: lo escrito no se pierde, queda en el telefono.
      await saveDraft();
      status.textContent = ex.status === 0 ? 'Sin conexión · guardado en este teléfono' : 'No se guardó';
      toast(ex.status === 0 ? 'Sin conexión. Lo que escribiste quedó guardado en este teléfono; vuelve a guardar cuando tengas señal.' : ex.message, 'err');
      return false;
    } finally {
      btn.disabled = false;
    }
  };

  const close = async () => {
    if (dirty && !(await ask({ title: '¿Salir sin guardar?', text: 'Perderás lo que escribiste desde la última vez que guardaste.', ok: 'Salir', danger: true }))) return;
    clearTimeout(draftTimer);
    dropDraft(visit.id); // eligio descartar
    teardown();
    onClose?.(visit);
  };
  const teardown = () => {
    removeEventListener('keydown', onKey);
    removeEventListener('beforeunload', onUnload);
    editor.destroy?.();
    root.remove();
    document.body.classList.remove('writing');
    open = null;
  };
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
    }
  };
  // Cerrar la pestaña con cambios: el aviso del navegador (el unico dialogo
  // nativo que se usa, porque no hay otra forma de frenar un cierre).
  const onUnload = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  addEventListener('keydown', onKey);
  addEventListener('beforeunload', onUnload);
  root.querySelector('[data-w-save]').addEventListener('click', doSave);

  // ---------- Escríbelo por mí ----------
  // Claude mira las fotos y los lugares de la visita y escribe un borrador. No se
  // guarda solo: entra al editor y la persona decide.
  const aiBtn = root.querySelector('[data-w-ai]');
  api('story')
    .then((r) => (aiBtn.hidden = !r.ready))
    .catch(() => {});
  aiBtn.addEventListener('click', () => openAiDraft({ visit, photos: photos(), pins: pins(), editor, markDirty, status }));
  root.querySelector('[data-w-close]').addEventListener('click', close);
  open = { close, teardown, isDirty: () => dirty };
}

// Al navegar a otra parte (boton atras del telefono). Sin cambios se cierra;
// con cambios devuelve false y quien navega decide (pregunta y, si la persona
// se queda, vuelve al editor). force: cerrar igual.
export function closeWriter(force = false) {
  if (!open) return true;
  if (open.isDirty() && !force) return false;
  open.teardown();
  return true;
}

// ---------- Escríbelo por mí: la ventana ----------

const TONES = [
  ['cercano', '😊 Cercano', 'Como contándoselo a un amigo'],
  ['guia', '🧭 Guía práctica', 'Para quien quiera ir: qué ver, consejos'],
  ['poetico', '🌅 Evocador', 'Luz, olores, sonidos'],
];

async function openAiDraft({ visit, photos, pins, editor, markDirty, status }) {
  const nPhotos = Math.min(photos.length, 10);
  const { root, close } = openModal(
    `<div class="ai-draft">
      <div class="ai-head"><span class="ai-spark" aria-hidden="true">✨</span><div><h2>Escríbelo por mí</h2>
      <p class="note">Claude mira ${nPhotos ? (nPhotos === 1 ? 'tu foto' : `tus ${nPhotos} fotos`) : 'la visita'}${pins.length ? (pins.length === 1 ? ' y el lugar que marcaste' : ` y los ${pins.length} lugares que marcaste`) : ''}, y escribe un borrador en primera persona. No inventa lo que no está: tú lo editas después.</p></div></div>
      <label class="field"><span>¿Algo que quieras que diga? (opcional)</span>
        <textarea name="notes" rows="3" maxlength="2000" placeholder="Fuimos con mi hermana; lo mejor fue el mirador al atardecer; el mercado estaba lleno…"></textarea></label>
      <p class="profile-label">Tono</p>
      <div class="ai-tones" role="radiogroup">${TONES.map(([k, t, d], i) => `<button type="button" data-tone="${k}" class="${i === 0 ? 'on' : ''}"><b>${t}</b><small>${d}</small></button>`).join('')}</div>
      <p class="form-error" hidden></p>
      <div class="actions"><button class="secondary" data-close>Cancelar</button><button class="primary" data-ai-go>✨ Escribir borrador</button></div>
      <div class="ai-working" hidden><div class="ai-orb"></div><p>Mirando tus fotos y escribiendo…</p></div>
    </div>`,
    { label: 'Escríbelo por mí' },
  );
  let tone = 'cercano';
  root.querySelectorAll('[data-tone]').forEach((b) =>
    b.addEventListener('click', () => {
      tone = b.dataset.tone;
      root.querySelectorAll('[data-tone]').forEach((x) => x.classList.toggle('on', x === b));
    }),
  );
  const err = root.querySelector('.form-error');
  root.querySelector('[data-ai-go]').addEventListener('click', async () => {
    err.hidden = true;
    const working = root.querySelector('.ai-working');
    working.hidden = false;
    root.querySelector('.actions').hidden = true;
    try {
      const r = await api('story', { method: 'POST', query: { visit: visit.id }, body: { notes: root.querySelector('[name=notes]').value, tone } });
      const current = await editor.save();
      const blocks = toEditor(r.blocks);
      // Sin relato todavia: entra directo. Con relato: se pregunta, no se pisa.
      let how = 'replace';
      if (current.blocks.length) {
        close();
        how = await chooseHow();
        if (!how) return;
      } else close();
      if (how === 'replace') await editor.render({ blocks });
      else for (const b of blocks) editor.blocks.insert(b.type, b.data, undefined, undefined, false, false);
      markDirty();
      status.textContent = `Borrador de Claude · sin guardar${r.left != null ? ` · te quedan ${r.left} hoy` : ''}`;
      toast('Listo: revísalo y cámbialo a tu gusto ✍️');
    } catch (ex) {
      working.hidden = true;
      root.querySelector('.actions').hidden = false;
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

function chooseHow() {
  return new Promise((resolve) => {
    const { root, close } = openModal(
      `<h2>Ya tienes un relato</h2><p class="note">¿Qué hago con el borrador?</p>
       <div class="actions"><button class="secondary" data-how="">Cancelar</button><button class="secondary" data-how="append">Agregarlo al final</button><button class="primary" data-how="replace">Reemplazar el mío</button></div>`,
      { label: 'Borrador', onClose: () => resolve(null) },
    );
    root.querySelectorAll('[data-how]').forEach((b) =>
      b.addEventListener('click', () => {
        resolve(b.dataset.how || null);
        close();
      }),
    );
  });
}
