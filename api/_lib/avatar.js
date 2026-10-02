// La imagen de cada persona. En users.avatar se guarda una de estas:
//
//   NULL                      la inicial del nombre (lo de siempre)
//   "emoji:<emoji>:<color>"   un icono de la lista, sobre un color de la lista
//   "photo:<cfId>"            una foto subida a Cloudflare Images
//   "google"                  la foto de su cuenta de Google (users.googlePicture)
//
// Hacia afuera sale como { kind, emoji, color, url }: la web y la app lo pintan
// igual sin saber como se guarda.

import { signedUrl, imagesReady } from './images.js';

export const AVATAR_EMOJIS = ['🧭', '✈️', '🌍', '🏔️', '🏝️', '🏕️', '🗺️', '🚐', '🚲', '⛵', '🎒', '📸', '🌋', '🏛️', '🌵', '🌊', '🐢', '🦜', '☕', '🌮'];
export const AVATAR_COLORS = ['#f2545b', '#ff9a62', '#f59e0b', '#10b981', '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', '#172033'];

// Solo fotos de Google: googleusercontent es donde Google sirve las de las cuentas.
const GOOGLE_PIC = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//;
export const cleanGooglePicture = (url) => (typeof url === 'string' && GOOGLE_PIC.test(url) && url.length < 500 ? url : null);

export function avatarOf(u) {
  const raw = u?.avatar ?? '';
  if (raw.startsWith('emoji:')) {
    const [, emoji, color] = raw.split(':');
    if (AVATAR_EMOJIS.includes(emoji)) return { kind: 'emoji', emoji, color: AVATAR_COLORS.includes(color) ? color : AVATAR_COLORS[0] };
  }
  if (raw.startsWith('photo:') && imagesReady()) return { kind: 'photo', url: signedUrl(raw.slice(6), 'ttthumb') };
  if (raw === 'google' && u.googlePicture) return { kind: 'google', url: u.googlePicture };
  return { kind: 'initial' };
}

// Lo que pide la persona -> lo que se guarda, o { error }. La foto subida se
// valida aparte (hay que preguntarle a Cloudflare): aqui solo su forma.
export function parseAvatar(input, u) {
  const kind = input?.kind;
  if (kind === 'initial') return { value: null };
  if (kind === 'emoji') {
    if (!AVATAR_EMOJIS.includes(input.emoji)) return { error: 'Ese ícono no está en la lista.' };
    const color = AVATAR_COLORS.includes(input.color) ? input.color : AVATAR_COLORS[0];
    return { value: `emoji:${input.emoji}:${color}` };
  }
  if (kind === 'google') {
    if (!u.googlePicture) return { error: 'Tu cuenta de Google no tiene foto. Entra con Google una vez para traerla.' };
    return { value: 'google' };
  }
  if (kind === 'photo') {
    const cfId = String(input.cfId ?? '');
    if (!/^[\w-]{1,100}$/.test(cfId)) return { error: 'Foto inválida.' };
    return { value: `photo:${cfId}`, cfId };
  }
  return { error: 'Elige una foto, un ícono o tu inicial.' };
}

/** El cfId de la foto subida que tiene puesta, si tiene una (para borrarla al cambiar). */
export const avatarPhotoId = (raw) => (raw?.startsWith('photo:') ? raw.slice(6) : null);
