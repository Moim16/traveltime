// Instalar la app en el telefono (PWA) y el service worker (sw.js).
//
// Android/Chrome avisa que se puede instalar (beforeinstallprompt) y abre su
// propio dialogo. iPhone no avisa nunca: ahi se explica a mano (Compartir ->
// Agregar a pantalla de inicio).

import { modal } from './ui.js';

let deferred = null;
const listeners = new Set();

if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else addEventListener('load', register);
}

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // el boton lo pone la app, en la portada
  deferred = e;
  listeners.forEach((fn) => fn());
});
addEventListener('appinstalled', () => {
  deferred = null;
  listeners.forEach((fn) => fn());
});

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

// Si tiene sentido mostrar "Instalar app".
export const canInstall = () => !standalone() && (Boolean(deferred) || ios());
// Devuelve la funcion para dejar de escuchar (la portada se rehace a menudo).
export const onInstallChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

export async function install() {
  if (deferred) {
    deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null;
    listeners.forEach((fn) => fn());
    return;
  }
  modal(
    `<h2>Instalar en el iPhone</h2>
     <ol class="steps-ios">
       <li>Toca <b>Compartir</b> <span aria-hidden="true">⬆️</span> abajo, en Safari.</li>
       <li>Elige <b>Agregar a pantalla de inicio</b>.</li>
       <li>Toca <b>Agregar</b>. TravelTime queda con su ícono, como cualquier app.</li>
     </ol>
     <div class="actions"><button class="primary" data-close autofocus>Entendido</button></div>`,
    { label: 'Instalar en el iPhone' },
  );
}
