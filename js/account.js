// Quien esta usando la app: entrar con Google, el perfil (nombre, imagen,
// apariencia) y salir. Sin cuenta se puede recorrer el mapa; marcar y escribir
// visitas pide entrar. Usuario y contraseña quedan solo para las cuentas de
// antes que todavia no conectaron Google (config.legacyLogin).
//
// Google: el boton oficial de Google Identity Services (se carga al abrir la
// ventana, no con la app). Google le da al navegador un ID token firmado y el
// servidor lo verifica (api/auth.js?google=1).

import { api, getToken, setToken } from './api.js';
import { modal, esc, toast, busy } from './ui.js';
import { avatarHtml, AVATAR_EMOJIS, AVATAR_COLORS } from './avatar.js';
import { currentBasemap, setBasemap } from './basemap.js';
import { INTERESTS } from './interests.js';

let me = null;
const listeners = new Set();

export const current = () => me;
export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(me));

// { googleClientId, passwordSignup, legacyLogin }: que formas de entrar ofrece el servidor.
let config = { googleClientId: null, passwordSignup: false, legacyLogin: false };
const configReady = api('auth', { query: { config: 1 } })
  .then((c) => (config = c))
  .catch(() => config);

export async function init() {
  if (!getToken()) return null;
  try {
    me = (await api('auth')).me;
  } catch {
    setToken(null);
    me = null;
  }
  return me;
}

async function signedIn(data) {
  setToken(data.token);
  me = data.user;
  // El GET trae ademas si tiene Google o contraseña (para "Tu cuenta").
  try {
    me = (await api('auth')).me;
  } catch {}
  emit();
  if (data.recovery) showRecovery(data.recovery, true);
  else if (data.created) toast(`¡Bienvenido! Tu usuario es @${me.name}.`);
}

// ---------- Google Identity Services ----------

let gisLoading = null;
function loadGis() {
  return (gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => {
      gisLoading = null;
      reject(new Error('No se pudo cargar el botón de Google. Revisa tu conexión.'));
    };
    document.head.append(s);
  }));
}

// Pinta el boton de Google en el. onCredential(idToken) se llama al elegir la cuenta.
async function googleButton(el, onCredential, { text = 'continue_with' } = {}) {
  await configReady;
  if (!config.googleClientId) return false;
  try {
    const google = await loadGis();
    google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: (r) => onCredential(r.credential),
      ux_mode: 'popup',
      auto_select: false,
      cancel_on_tap_outside: true,
      use_fedcm_for_button: true,
    });
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    google.accounts.id.renderButton(el, {
      type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill',
      text, locale: 'es', logo_alignment: 'left', width: Math.min(360, el.clientWidth || 320),
    });
    return true;
  } catch (e) {
    el.innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return false;
  }
}

// El codigo se ve UNA vez: si no se guarda ahora, no hay como volver a verlo.
function showRecovery(code, isNew) {
  const { root } = modal(
    `<h2>${isNew ? 'Guarda tu código de recuperación' : 'Tu código nuevo'}</h2>
     <p class="note">Si olvidas la contraseña, con este código vuelves a entrar. No se puede volver a ver: anótalo o guárdalo en un lugar seguro.</p>
     <div class="code" aria-label="Código de recuperación">${esc(code)}</div>
     <div class="actions"><button class="secondary" data-copy>Copiar</button><button class="primary" data-close autofocus>Ya lo guardé</button></div>`,
    { label: 'Código de recuperación' },
  );
  root.querySelector('[data-copy]').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(code);
      e.target.textContent = 'Copiado ✓';
    } catch {
      toast('No se pudo copiar. Anótalo a mano.', 'err');
    }
  });
}

const field = (name, label, type = 'text', extra = '') =>
  `<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${extra}></label>`;

// El bloque de Google de la ventana de entrar; se llena despues (renderButton).
const googleBlock = () => `<div class="google-block" hidden><div class="g-btn"></div></div>`;

const VIEWS = {
  login: () => `
    <div class="auth-hero"><span class="auth-logo" aria-hidden="true">✈</span><h2>Entra a TravelTime</h2>
    <p class="note">Con tu cuenta de Google, sin contraseñas. Tus lugares son privados: solo tú los ves, salvo lo que decidas publicar.</p></div>
    ${googleBlock()}
    <p class="note g-missing" hidden>Entrar con Google no está disponible ahora. Intenta en un rato.</p>
    ${config.legacyLogin ? '<p class="switch legacy-link"><button class="link" data-view="legacy">¿Tu cuenta es de antes, con usuario y contraseña?</button></p>' : ''}`,
  // Solo mientras quede una cuenta sin Google: se entra para conectarla.
  legacy: () => `
    <h2>Cuenta con contraseña</h2>
    <p class="note">Entra una última vez con tu usuario y, en <b>Tu perfil</b>, conecta Google. Después se entra solo con Google.</p>
    <form data-form="login">
      ${field('name', 'Usuario', 'text', 'autocomplete="username" autocapitalize="none" required')}
      ${field('password', 'Contraseña', 'password', 'autocomplete="current-password" required')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Entrar</button>
    </form>
    <p class="switch"><button class="link" data-view="login">Volver</button> · <button class="link" data-view="recover">Olvidé mi contraseña</button></p>`,
  recover: () => `
    <h2>Recuperar la cuenta</h2>
    <p class="note">Con el código de recuperación que guardaste al crear la cuenta.</p>
    <form data-form="recover">
      ${field('name', 'Usuario', 'text', 'autocomplete="username" autocapitalize="none" required autofocus')}
      ${field('code', 'Código de recuperación', 'text', 'autocapitalize="characters" placeholder="XXXX-XXXX-XXXX" required')}
      ${field('password', 'Contraseña nueva (mínimo 8)', 'password', 'autocomplete="new-password" required minlength="8"')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Entrar con el código</button>
    </form>
    <p class="switch"><button class="link" data-view="legacy">Volver</button></p>`,
};

// reason: por que se pide entrar ("Entra para marcar lugares"), si aplica.
// Crear cuenta y entrar son lo mismo con Google: "signup" abre la misma ventana.
export async function openAuth(view = 'login', reason = '') {
  await configReady;
  if (!VIEWS[view]) view = 'login';
  const { root, close } = modal('', { label: 'Entrar' });
  const showError = (msg) => {
    let err = root.querySelector('.g-error');
    if (!err) {
      err = document.createElement('p');
      err.className = 'form-error g-error';
      root.querySelector('.g-btn')?.after(err);
    }
    err.textContent = msg;
    err.hidden = false;
  };
  const onGoogle = async (credential) => {
    try {
      const r = await api('auth', { method: 'POST', query: { google: 1 }, body: { credential } });
      close();
      await signedIn(r);
    } catch (ex) {
      showError(ex.message);
    }
  };
  const show = async (name) => {
    root.innerHTML = (reason && name === 'login' ? `<p class="reason">${esc(reason)}</p>` : '') + VIEWS[name]();
    const block = root.querySelector('.google-block');
    if (block) {
      if (await googleButton(block.querySelector('.g-btn'), onGoogle)) block.hidden = false;
      else root.querySelector('.g-missing').hidden = false;
    } else root.querySelector('form [name]')?.focus();
  };
  show(view);

  root.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) show(v.dataset.view);
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.form-error');
    err.hidden = true;
    await busy(form.querySelector('button.primary'), async () => {
      try {
        const r = form.dataset.form === 'recover'
          ? await api('auth', { method: 'POST', query: { recover: 1 }, body: data })
          : await api('auth', { method: 'POST', body: data });
        close();
        await signedIn(r);
        // Entro con la contraseña: lo unico que le queda es conectar Google.
        if (!me.hasGoogle) openAccount();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}

// ---------- Tu perfil ----------

const THEMES = [
  { key: 'auto', label: 'Sistema', icon: '🖥️' },
  { key: 'light', label: 'Claro', icon: '☀️' },
  { key: 'dark', label: 'Oscuro', icon: '🌙' },
  { key: 'color', label: 'Colorido', icon: '🎨' },
];

// La foto de perfil: se achica a 512 px y se sube directo a Cloudflare.
async function squareJpeg(file) {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const out = Math.min(512, side);
  const canvas = new OffscreenCanvas(out, out);
  // Recorte cuadrado al centro: el avatar es redondo.
  canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
  img.close?.();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
}

export async function openAccount() {
  await configReady;
  // Lo elegido se guarda al tocar "Guardar"; el tema, al momento (es del navegador).
  let draft = { ...(me.avatar ?? { kind: 'initial' }) };
  let color = draft.color ?? AVATAR_COLORS[0];
  let uploaded = null; // { cfId, url } de una foto recien subida
  const about = me.about ?? {};
  const interests = new Set(about.interests ?? []);

  const { root, close } = modal(
    `<div class="profile">
      <div class="profile-head">
        <div class="profile-av" data-preview></div>
        <div><h2>${esc(me.fullName || me.name)}</h2><p class="note">@${esc(me.name)}${me.email ? ` · ${esc(me.email)}` : ''}</p></div>
      </div>

      ${me.hasGoogle
        ? '<p class="note g-linked">✓ Entras con Google.</p>'
        : `<div class="link-google"><p class="reason">Conecta tu cuenta de Google: desde ahora se entra solo con Google, sin contraseña.</p><div class="g-btn"></div><p class="form-error" hidden></p></div>`}

      <label class="field"><span>Tu nombre</span><input name="fullName" maxlength="80" autocomplete="name" value="${esc(me.fullName ?? '')}"></label>

      <p class="profile-label">Tu imagen</p>
      <div class="av-modes" role="radiogroup" aria-label="Tu imagen">
        <button type="button" data-mode="initial">Inicial</button>
        ${me.hasGooglePicture ? '<button type="button" data-mode="google">Foto de Google</button>' : ''}
        <label class="av-upload"><input type="file" accept="image/*" hidden data-upload>📷 Subir foto</label>
      </div>
      <div class="av-emojis">${AVATAR_EMOJIS.map((e) => `<button type="button" data-emoji="${e}" aria-label="Icono ${e}">${e}</button>`).join('')}</div>
      <div class="av-colors">${AVATAR_COLORS.map((c) => `<button type="button" data-color="${c}" style="--av:${c}" aria-label="Color ${c}"></button>`).join('')}</div>

      <p class="profile-label">Sobre ti <small>· se ve en tu perfil público</small></p>
      <label class="field"><span>Preséntate</span><textarea name="bio" maxlength="500" rows="3" placeholder="Qué te mueve a viajar, cómo lo haces, lo que te gustaría que supieran…">${esc(about.bio ?? '')}</textarea></label>
      <div class="field-row">
        <label class="field"><span>🏠 Vives en</span><input name="livesIn" maxlength="60" placeholder="Managua, Nicaragua" value="${esc(about.livesIn ?? '')}"></label>
        <label class="field"><span>🗣️ Idiomas (separados por coma)</span><input name="languages" maxlength="150" placeholder="Español, Inglés" value="${esc((about.languages ?? []).join(', '))}"></label>
      </div>
      <label class="field"><span>✨ El viaje de tus sueños</span><input name="dream" maxlength="80" placeholder="Japón en primavera" value="${esc(about.dream ?? '')}"></label>
      <p class="profile-sub">🎒 Te gusta viajar por</p>
      <div class="pf-chips pick">${Object.entries(INTERESTS).map(([k, v]) => `<button type="button" class="pf-chip" data-interest="${k}" aria-pressed="${interests.has(k)}">${v.emoji} ${esc(v.label)}</button>`).join('')}</div>

      <p class="profile-label">Apariencia</p>
      <div class="theme-pick" role="radiogroup" aria-label="Apariencia">${THEMES.map((t) => `<button type="button" data-theme-key="${t.key}"><span>${t.icon}</span>${t.label}</button>`).join('')}</div>

      <p class="form-error" data-err hidden></p>
      <div class="actions"><button class="danger-link" data-logout>Salir</button><span class="grow"></span><button class="secondary" data-close>Cerrar</button><button class="primary" data-save>Guardar</button></div>
    </div>`,
    { label: 'Editar perfil' },
  );

  const err = root.querySelector('[data-err]');
  const paint = () => {
    const shown = draft.kind === 'emoji' ? { ...draft, color } : draft.kind === 'photo' && uploaded ? { kind: 'photo', url: uploaded.url } : draft;
    root.querySelector('[data-preview]').innerHTML = avatarHtml(shown, root.querySelector('[name=fullName]').value || me.name, 'avatar-xl');
    root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === draft.kind));
    root.querySelector('.av-upload').classList.toggle('on', draft.kind === 'photo');
    root.querySelectorAll('[data-emoji]').forEach((b) => b.classList.toggle('on', draft.kind === 'emoji' && b.dataset.emoji === draft.emoji));
    root.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
    root.querySelector('.av-colors').classList.toggle('dim', draft.kind !== 'emoji');
    const theme = currentBasemap(true).key;
    root.querySelectorAll('[data-theme-key]').forEach((b) => b.classList.toggle('on', b.dataset.themeKey === theme));
  };
  paint();
  root.querySelector('[name=fullName]').addEventListener('input', paint);

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.mode) draft = t.dataset.mode === 'google' ? { kind: 'google', url: null } : { kind: 'initial' };
    else if (t.dataset.emoji) draft = { kind: 'emoji', emoji: t.dataset.emoji };
    else if (t.dataset.color) {
      color = t.dataset.color;
      if (draft.kind !== 'emoji') draft = { kind: 'emoji', emoji: AVATAR_EMOJIS[0] };
    } else if (t.dataset.themeKey) setBasemap(t.dataset.themeKey);
    else if (t.dataset.interest) {
      const k = t.dataset.interest;
      interests.has(k) ? interests.delete(k) : interests.add(k);
      t.setAttribute('aria-pressed', String(interests.has(k)));
      return;
    } else return;
    // La foto de Google se ve en la vista previa solo despues de guardar (la URL la da el servidor).
    if (draft.kind === 'google' && me.avatar?.kind === 'google') draft = { ...me.avatar };
    paint();
  });

  root.querySelector('[data-upload]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    err.hidden = true;
    const label = root.querySelector('.av-upload');
    label.classList.add('busy');
    try {
      const blob = await squareJpeg(file);
      const { cfId, uploadURL } = await api('auth', { method: 'POST', query: { avatarUpload: 1 } });
      const form = new FormData();
      form.append('file', blob, 'avatar.jpg');
      const r = await fetch(uploadURL, { method: 'POST', body: form });
      if (!r.ok) throw new Error('No se pudo subir la foto. Intenta de nuevo.');
      uploaded = { cfId, url: URL.createObjectURL(blob) };
      draft = { kind: 'photo' };
      paint();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      label.classList.remove('busy');
    }
  });

  root.querySelector('[data-save]').addEventListener('click', async (e) => {
    err.hidden = true;
    const val = (n) => root.querySelector(`[name=${n}]`).value;
    const body = {
      fullName: val('fullName'),
      bio: val('bio'),
      livesIn: val('livesIn'),
      dream: val('dream'),
      languages: val('languages').split(',').map((l) => l.trim()).filter(Boolean),
      interests: [...interests],
    };
    if (draft.kind === 'emoji') body.avatar = { kind: 'emoji', emoji: draft.emoji, color };
    else if (draft.kind === 'photo') {
      // Sin foto nueva y con la de antes puesta: no se toca.
      if (uploaded) body.avatar = { kind: 'photo', cfId: uploaded.cfId };
    } else body.avatar = { kind: draft.kind };
    await busy(e.target, async () => {
      try {
        me = (await api('auth', { method: 'PUT', query: { profile: 1 }, body })).me;
        emit();
        close();
        toast('Perfil guardado ✓');
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });

  const gBox = root.querySelector('.link-google');
  if (gBox) {
    googleButton(gBox.querySelector('.g-btn'), async (credential) => {
      const gErr = gBox.querySelector('.form-error');
      gErr.hidden = true;
      try {
        await api('auth', { method: 'POST', query: { google: 1, link: 1 }, body: { credential } });
        me = (await api('auth')).me;
        emit();
        close();
        toast('Listo: desde ahora entras con Google.');
      } catch (ex) {
        gErr.textContent = ex.message;
        gErr.hidden = false;
      }
    });
  }
  root.querySelector('[data-logout]').addEventListener('click', async () => {
    try {
      await api('auth', { method: 'POST', query: { logout: 1 } });
    } catch {}
    try {
      window.google?.accounts.id.disableAutoSelect();
    } catch {}
    setToken(null);
    me = null;
    close();
    emit();
    toast('Saliste de tu cuenta.');
  });
}
