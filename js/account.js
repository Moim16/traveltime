// Quien esta usando la app: entrar, crear cuenta, recuperar y salir.
// Sin cuenta se puede recorrer el mapa; marcar y escribir visitas pide entrar.

import { api, getToken, setToken } from './api.js';
import { modal, esc, toast, busy } from './ui.js';

let me = null;
const listeners = new Set();

export const current = () => me;
export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(me));

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

function signedIn(data) {
  setToken(data.token);
  me = data.user;
  emit();
  if (data.recovery) showRecovery(data.recovery, true);
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

const VIEWS = {
  login: () => `
    <h2>Entrar</h2>
    <form data-form="login">
      ${field('name', 'Usuario', 'text', 'autocomplete="username" autocapitalize="none" required autofocus')}
      ${field('password', 'Contraseña', 'password', 'autocomplete="current-password" required')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Entrar</button>
    </form>
    <p class="switch"><button class="link" data-view="signup">Crear una cuenta</button> · <button class="link" data-view="recover">Olvidé mi contraseña</button></p>`,
  signup: () => `
    <h2>Crear cuenta</h2>
    <form data-form="signup">
      ${field('fullName', 'Tu nombre', 'text', 'autocomplete="name" autofocus')}
      ${field('email', 'Correo', 'email', 'autocomplete="email" required')}
      ${field('name', 'Usuario (letras, números, . _ -)', 'text', 'autocomplete="off" autocapitalize="none" spellcheck="false" required minlength="2" maxlength="20" pattern="[\\p{L}\\p{N}._\\-]{2,20}" data-msg="Usa de 2 a 20 letras, números, punto, guion o guion bajo, sin espacios ni @."')}
      ${field('password', 'Contraseña (mínimo 8)', 'password', 'autocomplete="new-password" required minlength="8"')}
      <p class="form-error" hidden></p>
      <button class="primary wide">Crear cuenta</button>
    </form>
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
    <p class="note">Con el código de recuperación que guardaste al crear la cuenta.</p>
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
export function openAuth(view = 'login', reason = '') {
  const { root, close } = modal('', { label: 'Cuenta' });
  const show = (name, arg) => {
    root.innerHTML = (reason && name === 'login' ? `<p class="reason">${esc(reason)}</p>` : '') + VIEWS[name](arg);
    root.querySelector('[autofocus]')?.focus();
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
          signedIn(await api('auth', { method: 'POST', body: data }));
          close();
        } else if (kind === 'signup') {
          const r = await api('auth', { method: 'POST', query: { signup: 1 }, body: data });
          if (r.pending) return show('verify', r.email);
          close();
          signedIn(r);
        } else if (kind === 'verify') {
          const r = await api('auth', { method: 'POST', query: { verify: 1 }, body: { email: form.dataset.email, code: data.code } });
          close();
          signedIn(r);
        } else if (kind === 'recover') {
          const r = await api('auth', { method: 'POST', query: { recover: 1 }, body: data });
          close();
          signedIn(r);
        }
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}

export function openAccount() {
  const { root, close } = modal(
    `<h2>${esc(me.fullName || me.name)}</h2>
     <p class="note">@${esc(me.name)}${me.email ? ` · ${esc(me.email)}` : ''}</p>
     <form data-form="recovery" class="inline-form">
       ${field('currentPassword', 'Tu contraseña, para sacar un código de recuperación nuevo', 'password', 'autocomplete="current-password" required')}
       <p class="form-error" hidden></p>
       <button class="secondary wide">Generar código nuevo</button>
     </form>
     <div class="actions"><button class="secondary" data-close>Cerrar</button><button class="danger" data-logout>Salir</button></div>`,
    { label: 'Tu cuenta' },
  );
  root.querySelector('[data-logout]').addEventListener('click', async () => {
    try {
      await api('auth', { method: 'POST', query: { logout: 1 } });
    } catch {}
    setToken(null);
    me = null;
    close();
    emit();
    toast('Saliste de tu cuenta.');
  });
  root.querySelector('[data-form="recovery"]').addEventListener('submit', async (e) => {
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
