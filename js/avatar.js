// El avatar de una persona, igual en todos lados: foto (subida o de Google),
// icono sobre su color, o la inicial. avatar es lo que manda la API
// ({ kind, emoji, color, url }, ver api/_lib/avatar.js).

import { esc } from './ui.js';

// Los mismos de api/_lib/avatar.js: el servidor rechaza cualquier otro.
export const AVATAR_EMOJIS = ['🧭', '✈️', '🌍', '🏔️', '🏝️', '🏕️', '🗺️', '🚐', '🚲', '⛵', '🎒', '📸', '🌋', '🏛️', '🌵', '🌊', '🐢', '🦜', '☕', '🌮'];
export const AVATAR_COLORS = ['#f2545b', '#ff9a62', '#f59e0b', '#10b981', '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', '#172033'];

const initial = (name) => esc((name ?? '?').trim().charAt(0).toUpperCase() || '?');

// cls: la clase de tamaño (avatar-sm, avatar-lg…). Sin texto alternativo: el
// nombre siempre va al lado.
export function avatarHtml(avatar, name, cls = 'avatar-sm') {
  const a = avatar ?? { kind: 'initial' };
  if ((a.kind === 'photo' || a.kind === 'google') && a.url) {
    // referrerpolicy: las fotos de Google a veces no cargan si se manda el origen.
    return `<span class="${cls} av-photo" aria-hidden="true"><img src="${esc(a.url)}" alt="" referrerpolicy="no-referrer" loading="lazy"></span>`;
  }
  if (a.kind === 'emoji') return `<span class="${cls} av-emoji" style="--av:${esc(a.color)}" aria-hidden="true">${esc(a.emoji)}</span>`;
  return `<span class="${cls}" aria-hidden="true">${initial(name)}</span>`;
}
