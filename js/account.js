// Quien esta usando la app: entrar (con Google o con usuario y contraseña),
// crear cuenta, recuperar y salir. Sin cuenta se puede recorrer el mapa;
// marcar y escribir visitas pide entrar.
//
// Google: el boton oficial de Google Identity Services (se carga al abrir la
// ventana, no con la app). Google le da al navegador un ID token firmado y el
// servidor lo verifica (api/auth.js?google=1). Sin GOOGLE_CLIENT_ID en el
// servidor, la ventana muestra solo usuario y contraseña, como antes.

import { api, getToken, setToken } from './api.js';
import { modal, esc, toast, busy } from './ui.js';

let me = null;
const listeners = new Set();

export const current = () => me;
export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(me));

// { googleClientId, passwordSignup }: que formas de entrar ofrece el servidor.
let config = { googleClientId: null, passwordSignup: true };
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

// El bloque de Google arriba de cada vista; se llena despues (renderButton).
const googleBlock = (note) => `<div class="google-block" hidden><div class="g-btn"></div>${note ? `<p class="note g-note">${note}</p>` : ''}<div class="or"><span>o con tu usuario</span></div></div>`;

const VIEWS = {
  login: () => `
    <h2>Entrar</h2>
    ${googleBlock()}
    <form data-form="login">
      ${field('name', 'Usuario', 'text', 'autocomplete="username" autocapitalize="none" required')}
      ${field('password', 'Contraseña', 'password', 'autocomplete="current-password" required')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Entrar</button>
    </form>
    <p class="switch"><button class="link" data-view="signup">Crear una cuenta</button> · <button class="link" data-view="recover">Olvidé mi contraseña</button></p>`,
  signup: () => `
    <h2>Crear cuenta</h2>
    ${googleBlock('Con Google no necesitas contraseña: tu correo ya viene confirmado.')}
    ${config.passwordSignup
      ? `<form data-form="signup">
      ${field('fullName', 'Tu nombre', 'text', 'autocomplete="name"')}
      ${field('email', 'Correo', 'email', 'autocomplete="email" required')}
      ${field('name', 'Usuario (letras, números, . _ -)', 'text', 'autocomplete="off" autocapitalize="none" spellcheck="false" required minlength="2" maxlength="20" pattern="[\\p{L}\\p{N}._\\-]{2,20}" data-msg="Usa de 2 a 20 letras, números, punto, guion o guion bajo, sin espacios ni @."')}
      ${field('password', 'Contraseña (mínimo 8)', 'password', 'autocomplete="new-password" required minlength="8"')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Crear cuenta</button>
    </form>`
      : '<p class="note">Por ahora las cuentas nuevas se crean con Google.</p>'}
    <p class="switch">¿Ya tienes cuenta? <button class="link" data-view="login">Entrar</button></p>`,
  verify: (email) => `
    <h2>Revisa tu correo</h2>
    <p class="note">Te mandamos un código de 6 dígitos a <b>${esc(email)}</b>. Vence en 15 minutos.</p>
    <form data-form="verify" data-email="${esc(email)}">
      ${field('code', 'Código', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Confirmar</button>
    </form>
    <p class="switch"><button class="link" data-view="signup">Volver</button></p>`,
  recover: () => `
    <h2>Recuperar la cuenta</h2>
    <p class="note">Si entras con Google, no necesitas esto: vuelve y usa el botón de Google. Si no, con el código de recuperación que guardaste al crear la cuenta.</p>
    <form data-form="recover">
      ${field('name', 'Usuario', 'text', 'autocomplete="username" autocapitalize="none" required autofocus')}
      ${field('code', 'Código de recuperación', 'text', 'autocapitalize="characters" placeholder="XXXX-XXXX-XXXX" required')}
      ${field('password', 'Contraseña nueva (mínimo 8)', 'password', 'autocomplete="new-password" required minlength="8"')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Entrar con el código</button>
    </form>
    <p class="switch"><button class="link" data-view="login">Volver</button></p>`,
};

// reason: por que se pide entrar ("Entra para marcar lugares"), si aplica.
export async function openAuth(view = 'login', reason = '') {
  await configReady;
  const { root, close } = modal('', { label: 'Cuenta' });
  // Un error de Google (cuenta ya existente sin verificar, token rechazado) va
  // justo debajo del boton de Google, no en el formulario de contraseña.
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
  // El motivo ("Crea tu cuenta para guardar…") se ve en entrar y en crear cuenta,
  // que son a donde lleva tocar algo que pide cuenta.
  const show = async (name, arg) => {
    root.innerHTML = (reason && (name === 'login' || name === 'signup') ? `<p class="reason">${esc(reason)}</p>` : '') + VIEWS[name](arg);
    const block = root.querySelector('.google-block');
    const withGoogle = block && (await googleButton(block.querySelector('.g-btn'), onGoogle, { text: name === 'signup' ? 'signup_with' : 'continue_with' }));
    if (withGoogle) block.hidden = false;
    // Con Google el foco queda en la ventana (el boton es un iframe de Google);
    // sin Google, en el primer campo.
    else root.querySelector('form [name]')?.focus();
  };
  show(view);

  root.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) show(v.dataset.view);
  });

  // El aviso del navegador para un pattern es "el formato no coincide": se
  // cambia por uno que diga que se espera.
  root.addEventListener('invalid', (e) => {
    if (e.target.dataset.msg && e.target.validity.patternMismatch) e.target.setCustomValidity(e.target.dataset.msg);
  }, true);
  root.addEventListener('input', (e) => e.target.setCustomValidity?.(''));

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.form-error');
    err.hidden = true;
    await busy(form.querySelector('button.primary'), async () => {
      try {
        const kind = form.dataset.form;
        if (kind === 'login') {
          const r = await api('auth', { method: 'POST', body: data });
          close();
          await signedIn(r);
        } else if (kind === 'signup') {
          const r = await api('auth', { method: 'POST', query: { signup: 1 }, body: data });
          if (r.pending) return show('verify', r.email);
          close();
          await signedIn(r);
        } else if (kind === 'verify') {
          const r = await api('auth', { method: 'POST', query: { verify: 1 }, body: { email: form.dataset.email, code: data.code } });
          close();
          await signedIn(r);
        } else if (kind === 'recover') {
          const r = await api('auth', { method: 'POST', query: { recover: 1 }, body: data });
          close();
          await signedIn(r);
        }
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}

export async function openAccount() {
  await configReady;
  const { root, close } = modal(
    `<h2>${esc(me.fullName || me.name)}</h2>
     <p class="note">@${esc(me.name)}${me.email ? ` · ${esc(me.email)}` : ''}</p>
     ${me.hasGoogle
       ? '<p class="note g-linked">✓ Conectada con Google: puedes entrar con el botón de Google.</p>'
       : config.googleClientId
         ? '<div class="link-google"><p class="note">Conecta tu cuenta de Google para entrar sin contraseña.</p><div class="g-btn"></div><p class="form-error" hidden></p></div>'
         : ''}
     ${me.hasPassword !== false
       ? `<form data-form="recovery" class="inline-form">
       ${field('currentPassword', 'Tu contraseña, para sacar un código de recuperación nuevo', 'password', 'autocomplete="current-password" required')}
       <p class="form-error" hidden></p>
       <button class="secondary wide">Generar código nuevo</button>
     </form>`
       : ''}
     <div class="actions"><button class="secondary" data-close>Cerrar</button><button class="danger" data-logout>Salir</button></div>`,
    { label: 'Tu cuenta' },
  );
  const gBox = root.querySelector('.link-google');
  if (gBox) {
    googleButton(gBox.querySelector('.g-btn'), async (credential) => {
      const err = gBox.querySelector('.form-error');
      err.hidden = true;
      try {
        await api('auth', { method: 'POST', query: { google: 1, link: 1 }, body: { credential } });
        me = (await api('auth')).me;
        close();
        toast('Listo: ya puedes entrar con Google.');
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
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
  root.querySelector('[data-form="recovery"]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = form.querySelector('.form-error');
    err.hidden = true;
    await busy(form.querySelector('button'), async () => {
      try {
        const r = await api('auth', { method: 'PUT', query: { recovery: 1 }, body: Object.fromEntries(new FormData(form)) });
        close();
        showRecovery(r.recovery, false);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}
