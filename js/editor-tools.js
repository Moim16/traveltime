// Herramientas propias del editor de la web (Editor.js 2.31), las mismas que
// tiene el de la app:
//
//   ColorTool  color del texto y resaltado, con 5 colores fijos (api/_lib/story.js
//              COLORS). Reemplaza al Marker de Editor.js: "Resaltar" en ambar es
//              el <mark> de siempre.
//   AlignTune  centrar un parrafo, un titulo o una cita.
//
// El centrado se guarda en data.align (como lo espera el servidor y la app);
// Editor.js lo maneja como "tune" del bloque: toEditor/fromEditor traducen.

import { COLORS } from './story.js';

const LABEL = { coral: 'Coral', amber: 'Ámbar', green: 'Verde', blue: 'Azul', violet: 'Violeta' };

export class ColorTool {
  static get isInline() {
    return true;
  }

  static get title() {
    return 'Color';
  }

  // Lo que el editor deja pasar al pegar o guardar: el color y nada mas.
  static get sanitize() {
    return { span: { 'data-color': true }, mark: { 'data-color': true } };
  }

  constructor({ api }) {
    this.api = api;
    this.range = null;
    this.button = null;
    this.palette = null;
  }

  render() {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.classList.add(this.api.styles.inlineToolButton, 'tt-color-btn');
    this.button.innerHTML = '<span aria-hidden="true">A</span>';
    this.button.title = 'Color y resaltado';
    return this.button;
  }

  // La paleta: abajo de la barra, se abre al tocar "A".
  renderActions() {
    this.palette = document.createElement('div');
    this.palette.className = 'tt-palette';
    this.palette.hidden = true;
    this.palette.innerHTML = `
      <span class="tt-palette-label">Texto</span>
      ${COLORS.map((c) => `<button type="button" data-text="${c}" title="${LABEL[c]}"><span data-color="${c}">A</span></button>`).join('')}
      <span class="tt-palette-label">Resaltar</span>
      ${COLORS.map((c) => `<button type="button" data-mark="${c}" title="Resaltar ${LABEL[c].toLowerCase()}"><mark ${c === 'amber' ? '' : `data-color="${c}"`}>ab</mark></button>`).join('')}
      <button type="button" data-clear title="Quitar color">✕</button>`;
    this.palette.addEventListener('mousedown', (e) => e.preventDefault()); // que no se pierda la seleccion
    this.palette.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.range) return;
      if (b.dataset.text) this.apply('span', b.dataset.text);
      else if (b.dataset.mark) this.apply('mark', b.dataset.mark);
      else if ('clear' in b.dataset) this.apply(null);
      this.api.inlineToolbar.close();
    });
    return this.palette;
  }

  surround(range) {
    this.range = range;
    this.palette.hidden = !this.palette.hidden;
  }

  // Envuelve lo seleccionado. Antes saca los colores que ya tenia adentro, para
  // no anidar un coral dentro de un azul.
  apply(tag, color) {
    const range = this.range;
    const frag = range.extractContents();
    const strip = (kind) => frag.querySelectorAll(kind).forEach((n) => n.replaceWith(...n.childNodes));
    if (tag === 'span' || tag === null) strip('span[data-color]');
    if (tag === 'mark' || tag === null) strip('mark');
    let node = frag;
    if (tag) {
      const el = document.createElement(tag);
      if (!(tag === 'mark' && color === 'amber')) el.dataset.color = color;
      el.append(frag);
      node = el;
    }
    range.insertNode(node);
    this.api.selection.expandToTag(node.nodeType === 1 ? node : range.commonAncestorContainer);
  }

  checkState() {
    const inColor = this.api.selection.findParentTag('SPAN') || this.api.selection.findParentTag('MARK');
    this.button?.classList.toggle(this.api.styles.inlineToolButtonActive, Boolean(inColor));
    return Boolean(inColor);
  }

  clear() {
    if (this.palette) this.palette.hidden = true;
  }
}

export class AlignTune {
  static get isTune() {
    return true;
  }

  constructor({ api, data, block }) {
    this.api = api;
    this.block = block;
    this.center = data?.alignment === 'center';
    this.wrapper = null;
  }

  render() {
    return {
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M5 18h14"/></svg>',
      title: 'Centrar',
      isActive: this.center,
      toggle: true,
      closeOnActivate: true,
      onActivate: () => {
        this.center = !this.center;
        this.wrapper?.classList.toggle('is-center', this.center);
        this.block.dispatchChange();
      },
    };
  }

  wrap(content) {
    this.wrapper = document.createElement('div');
    this.wrapper.classList.toggle('is-center', this.center);
    this.wrapper.append(content);
    return this.wrapper;
  }

  save() {
    return { alignment: this.center ? 'center' : 'left' };
  }
}

const ALIGNABLE = new Set(['paragraph', 'header', 'quote']);

/** Lo guardado -> lo que entiende Editor.js (data.align pasa a tunes.align). */
export const toEditor = (blocks = []) =>
  blocks.map((b) => {
    if (!ALIGNABLE.has(b.type)) return b;
    const { align, ...data } = b.data ?? {};
    return { ...b, data, tunes: { ...b.tunes, align: { alignment: align === 'center' ? 'center' : 'left' } } };
  });

/** Lo que devuelve Editor.js -> lo que se guarda. */
export const fromEditor = (blocks = []) =>
  blocks.map((b) => {
    const { tunes, ...rest } = b;
    if (!ALIGNABLE.has(b.type)) return rest;
    return { ...rest, data: { ...b.data, ...(tunes?.align?.alignment === 'center' ? { align: 'center' } : {}) } };
  });
