// Paginas a pantalla completa sobre el mapa: la portada (#/) y una visita
// publicada (#/p/12). El mapa sigue detras: en la portada es el globo que gira
// en el encabezado.

import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import { api } from './api.js';
import * as account from './account.js';
import { esc, toast, ask, modal, formatRange } from './ui.js';
import { renderStory } from './story.js';
import { avatarHtml } from './avatar.js';
import { INTERESTS } from './interests.js';
import { placePoint } from './geo.js';
import { kindOf, KINDS } from './pins.js';
import { currentBasemap } from './basemap.js';
import { canInstall, onInstallChange, install } from './install.js';

let page = null;

export function closePage() {
  page?.cleanup?.();
  page?.el.remove();
  page = null;
  document.body.classList.remove('on-page');
}

function openPage(className) {
  closePage();
  const el = document.createElement('div');
  el.className = `page ${className}`;
  document.body.append(el);
  document.body.classList.add('on-page');
  page = { el, cleanup: null };
  return el;
}

// Aparecer al entrar en pantalla, de a uno (cada .reveal con --i para escalonar).
function reveal(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    root.querySelectorAll('.reveal').forEach((n) => n.classList.add('in'));
    return null;
  }
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
    { root, rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  root.querySelectorAll('.reveal').forEach((n) => io.observe(n));
  return io;
}

// "Quiero ir" y "Ya estuve" piden cuenta: sin ella se abre el registro con el porque.
async function needAccount(why) {
  if (account.current()) return true;
  account.openAuth('signup', why);
  return false;
}

// Avisa al mapa que cambiaron lo visitado o "Quiero ir" (lo escucha js/app.js).
const changed = () => dispatchEvent(new Event('tt:data-changed'));

export async function wantToGo({ pinId, placeId, placeName, visitId }) {
  if (!(await needAccount('Crea tu cuenta para guardar lugares en tu lista "Quiero ir".'))) return null;
  try {
    const r = await api('wishes', { method: 'POST', body: pinId ? { fromPinId: pinId } : { placeId, placeName, sourceVisitId: visitId } });
    toast(r.already ? 'Ya estaba en tu lista "Quiero ir".' : 'Guardado en "Quiero ir" ✓');
    changed();
    return r.wish;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

// Ya estuve: mi propia visita en ese municipio con ese lugar; despues la escribo yo.
export async function beenThere({ pinId, title, go }) {
  if (!(await needAccount('Crea tu cuenta para guardar los lugares donde estuviste.'))) return;
  try {
    const r = await api('visits', { method: 'POST', body: { fromPinId: pinId, title } });
    toast('Visita creada con ese lugar. Ahora cuéntala tú.');
    changed();
    go(`${r.visit.placeId}/v/${r.visit.id}/editar`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// Invitaciones a viajes: "@moises te invito a «Centroamerica 2025»".
export const invitesHtml = (invites) =>
  invites.length
    ? `<div class="invites">${invites
        .map((i) => `<div class="invite"><span>🔔 <b>@${esc(i.invitedBy)}</b> te invitó a su viaje <b>«${esc(i.title)}»</b>. Si aceptas, verás las visitas de ese viaje y podrás sumar las tuyas.</span>
          <span class="invite-actions"><button class="primary small" data-invite="${i.tripId}" data-accept="1">Aceptar</button><button class="link" data-invite="${i.tripId}" data-accept="0">Rechazar</button></span></div>`)
        .join('')}</div>`
    : '';

export async function respondInvite(tripId, accept, go) {
  try {
    await api('trips', { method: 'POST', query: { id: tripId, respond: 1 }, body: { accept } });
    toast(accept ? 'Ya son compañeros de viaje.' : 'Invitación rechazada.');
    await new Promise((r) => {
      addEventListener('tt:data-loaded', r, { once: true });
      changed();
    });
    if (accept) go(`viaje/${tripId}`);
    else dispatchEvent(new Event('tt:rerender'));
  } catch (e) {
    toast(e.message, 'err');
  }
}

const authorLine = (a, avatar) => `<span class="author">${avatarHtml(avatar, a)}@${esc(a)}</span>`;
const placeShort = (pn) => (pn ?? '').split(',').filter((_, i, all) => i === 0 || i === all.length - 1).join(', ');

function cardHtml(v, i) {
  return `<article class="rec-card reveal" style="--i:${i % 6}">
    <a href="#/p/${v.id}" class="rec-link" aria-label="${esc(v.title)}">
      <div class="rec-cover">${v.cover ? `<img src="${esc(v.cover)}" alt="" loading="lazy">` : `<div class="rec-cover-empty"><span>${esc((v.placeName ?? v.title).split(',')[0].trim())}</span></div>`}
        <span class="rec-place">📍 ${esc(placeShort(v.placeName))}</span></div>
      <div class="rec-body">
        <h3>${esc(v.title)}</h3>
        ${v.excerpt ? `<p>${esc(v.excerpt)}</p>` : ''}
        <div class="rec-meta">${authorLine(v.author, v.authorAvatar)}<span>${v.photoCount ? `📷 ${v.photoCount}` : ''} ${v.pinCount ? `📍 ${v.pinCount}` : ''}</span></div>
      </div>
    </a>
  </article>`;
}

function placeChip(p, i) {
  const k = kindOf(p.kind);
  return `<li class="place-chip reveal" style="--i:${i % 8};--k:${k.color}">
    <a href="#/p/${p.visitId}" class="place-chip-main"><span class="pin-emoji">${k.emoji}</span>
      <span><b>${esc(p.name)}</b><small>${esc(placeShort(p.placeName))} · @${esc(p.author)}</small></span></a>
    <div class="place-chip-actions"><button class="chip-btn" data-want-pin="${p.id}">♡ Quiero ir</button><button class="chip-btn" data-been-pin="${p.id}" data-been-title="${esc(p.name)}">✓ Estuve</button></div>
  </li>`;
}

// ---------- Portada ----------

export async function renderHome({ go, countVisited, wishes, invites = () => [] }) {
  const el = openPage('home');
  const me = account.current();
  el.innerHTML = `
    <section class="hero">
      <div class="hero-inner">
        <p class="eyebrow reveal" style="--i:0">✈ TravelTime</p>
        <h1 class="reveal" style="--i:1">Cada lugar donde estuviste,<br><span class="grad">con su historia.</span></h1>
        <p class="hero-sub reveal" style="--i:2">Marca en el mapa los países, departamentos y ciudades que visitaste. Escribe lo que hiciste, con tus fotos y los lugares exactos. Y si quieres, compártelo para que otros descubran a dónde ir.</p>
        <div class="hero-cta reveal" style="--i:3">
          <a class="primary big" href="#/mundo">${me ? 'Abrir mi mapa' : 'Explorar el mapa'} →</a>

          <button class="secondary big install-btn" data-install hidden>📲 Instalar app</button>
        </div>
        <p class="hero-stats reveal" style="--i:4" id="home-stats"></p>
      </div>
      <a class="scroll-hint" href="#como" aria-label="Ver más">↓</a>
    </section>

    ${me ? `<section class="band mine reveal"><div class="wrap mine-row">
      <div><p class="eyebrow">Tu mapa</p><h2>Hola, ${esc(me.fullName || me.name)}</h2></div>
      <div class="mine-stats"><div><b>${countVisited()}</b><span>países visitados</span></div><div><b id="home-wish-count">${wishes().length}</b><span>quiero ir</span></div></div>
      <a class="secondary" href="#/mundo">Ver mi mapa →</a>
    </div>${invites().length ? `<div class="wrap">${invitesHtml(invites())}</div>` : ''}</section>` : ''}

    <section class="band" id="como"><div class="wrap">
      <p class="eyebrow reveal">Cómo funciona</p>
      <h2 class="reveal">Tres pasos, a tu ritmo</h2>
      <ol class="steps">
        <li class="step reveal" style="--i:0"><span class="step-n">1</span><span class="step-icon">🌎</span><h3>Marca dónde estuviste</h3><p>Del globo al país, del país al departamento y de ahí a la ciudad. El mapa se va pintando con cada lugar.</p></li>
        <li class="step reveal" style="--i:1"><span class="step-n">2</span><span class="step-icon">✍️</span><h3>Cuenta lo que hiciste</h3><p>Un relato como un post de blog: títulos, listas, avisos, tus fotos y los lugares exactos en el mapa.</p></li>
        <li class="step reveal" style="--i:2"><span class="step-n">3</span><span class="step-icon">✨</span><h3>Comparte y descubre</h3><p>Publica las visitas que quieras. De las de otros guarda lo que te guste en "Quiero ir" o márcalo como visitado.</p></li>
      </ol>
    </div></section>

    <section class="band alt"><div class="wrap">
      <div class="band-head"><div><p class="eyebrow reveal">Recomendaciones</p><h2 class="reveal">Lo que otros contaron</h2></div></div>
      <div class="rec-grid" id="home-recs"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
    </div></section>

    <section class="band"><div class="wrap">
      <p class="eyebrow reveal">Últimos lugares</p>
      <h2 class="reveal">Recién marcados en el mapa</h2>
      <ul class="place-chips" id="home-places"></ul>
    </div></section>

    ${me && wishes().length ? `<section class="band alt"><div class="wrap">
      <p class="eyebrow reveal">Quiero ir</p><h2 class="reveal">Tu lista de pendientes</h2>
      <ul class="wish-list" id="home-wishes">${wishes()
        .slice(0, 12)
        .map((w, i) => `<li class="reveal" style="--i:${i % 6}"><a href="#/${esc(w.placeId)}"><span class="pin-emoji" style="--k:${kindOf(w.kind).color}">${kindOf(w.kind).emoji}</span><span><b>${esc(w.name)}</b><small>${esc(placeShort(w.placeName))}</small></span></a></li>`)
        .join('')}</ul>
    </div></section>` : ''}

    <footer class="foot"><div class="wrap"><span>✈ TravelTime</span><span>Mapas © OpenStreetMap · geoBoundaries · Natural Earth</span></div></footer>`;
  const io = reveal(el);

  // El boton de instalar aparece cuando el navegador lo permite (o en iPhone, con instrucciones).
  const installBtn = el.querySelector('[data-install]');
  const syncInstall = () => (installBtn.hidden = !canInstall());
  syncInstall();
  const offInstall = onInstallChange(syncInstall);
  installBtn.addEventListener('click', install);
  page.cleanup = () => (io?.disconnect(), offInstall());

  // Antes de pedir las recomendaciones: si esa carga falla, aceptar igual funciona.
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-invite]');
    if (b) respondInvite(Number(b.dataset.invite), b.dataset.accept === '1', go);
  });

  el.querySelector('.scroll-hint').addEventListener('click', (e) => {
    e.preventDefault();
    el.querySelector('#como').scrollIntoView({ behavior: 'smooth' });
  });

  let data;
  try {
    data = await api('public', { query: { home: 1 } });
  } catch (e) {
    el.querySelector('#home-recs').innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }
  if (page?.el !== el) return;
  const { recommendations: recs, places, stats } = data;
  el.querySelector('#home-stats').textContent = stats.visits
    ? `${stats.visits} ${stats.visits === 1 ? 'historia publicada' : 'historias publicadas'} · ${stats.countries} ${stats.countries === 1 ? 'país' : 'países'} · ${stats.authors} ${stats.authors === 1 ? 'viajero' : 'viajeros'}`
    : '';
  el.querySelector('#home-recs').innerHTML = recs.length
    ? recs.map(cardHtml).join('')
    : `<div class="empty reveal"><span>🧭</span><p>Todavía no hay historias publicadas. ${me ? 'Publica una de tus visitas y será la primera.' : 'Crea tu cuenta y sé el primero en contar un viaje.'}</p></div>`;
  el.querySelector('#home-places').innerHTML = places.length
    ? places.map(placeChip).join('')
    : '<li class="note">Cuando alguien publique una visita con lugares, aparecen aquí.</li>';
  const io2 = reveal(el);
  const prev = page.cleanup;
  page.cleanup = () => (prev?.(), io2?.disconnect());

  // Los lugares guardados para los botones (quiero ir / estuve) de cada chip.
  const byId = new Map(places.map((p) => [p.id, p]));
  el.addEventListener('click', async (e) => {
    const want = e.target.closest('[data-want-pin]');
    if (want) {
      const w = await wantToGo({ pinId: Number(want.dataset.wantPin) });
      if (w) want.classList.add('done'), (want.textContent = '♥ En tu lista');
      return;
    }
    const been = e.target.closest('[data-been-pin]');
    if (been) {
      const p = byId.get(Number(been.dataset.beenPin));
      beenThere({ pinId: p.id, title: p.name, go });
    }
  });
}

// ---------- Viaje (mio en #/viaje/3, publicado en #/t/3) ----------

export async function renderTrip(id, { go, isPublic }) {
  const el = openPage('article trip');
  el.innerHTML = '<div class="article-loading"><div class="spinner"></div></div>';
  let t;
  try {
    t = isPublic ? (await api('public', { query: { trip: id } })).trip : (await api('trips', { query: { id } })).trip;
  } catch (e) {
    el.innerHTML = `<div class="article-missing"><span>🧳</span><h2>${esc(e.status === 404 ? (isPublic ? 'Este viaje no existe o ya no está publicado' : 'Este viaje no existe o no es tuyo') : 'No se pudo abrir')}</h2><a class="primary" href="#/">Ir al inicio</a></div>`;
    return;
  }
  if (page?.el !== el) return;
  const visitHref = (v) => (isPublic ? `#/p/${v.id}` : `#/${v.placeId}/v/${v.id}`);
  const meta = [formatRange(t.startDay, t.endDay), `${t.visitCount} ${t.visitCount === 1 ? 'visita' : 'visitas'}`, t.countryCount ? `${t.countryCount} ${t.countryCount === 1 ? 'país' : 'países'}` : null].filter(Boolean).join(' · ');
  el.innerHTML = `
    <header class="article-hero ${t.cover ? 'has-cover' : ''}">
      ${t.cover ? `<img class="article-cover" src="${esc(t.cover)}" alt="">` : ''}
      <div class="article-bar"><a class="glass-btn" href="${isPublic ? '#/' : '#/mundo'}" aria-label="Volver">←</a>${isPublic ? '<button class="glass-btn" data-share>Compartir</button>' : ''}</div>
      <div class="article-title wrap-narrow">
        <p class="eyebrow">🧳 Viaje</p>
        <h1>${esc(t.title)}</h1>
        <p class="article-meta">${isPublic ? `${authorLine(t.author)} · ` : ''}${esc(meta)}</p>
      </div>
    </header>
    <div class="article-body wrap-narrow">
      ${isPublic ? '' : t.role === 'owner' ? `<div class="trip-owner">
        <button class="secondary" data-trip-edit>✎ Renombrar</button>
        ${t.publishedAt
          ? `<span class="publish on"><span>🌎 <b>Publicado</b></span><a class="link" href="#/t/${t.id}">Ver página pública</a><button class="link" data-trip-publish="0">Dejar de publicar</button></span>`
          : '<button class="secondary" data-trip-publish="1">🌎 Publicar viaje</button>'}
        <button class="danger-link" data-trip-delete>Borrar viaje</button>
      </div>` : `<div class="trip-owner"><span class="shared-note">👥 Viaje de <b>@${esc(t.members.find((m) => m.role === 'owner')?.name ?? '')}</b>, compartido contigo. Puedes sumar tus visitas desde cada una, en «🧳 Viaje».</span></div>`}
      ${t.summary ? `<p class="trip-summary">${esc(t.summary)}</p>` : ''}
      ${isPublic ? '' : membersHtml(t)}
      ${t.visits.length ? `<div class="mini-map trip-map" id="trip-map"></div>` : ''}
      ${t.visits.length
        ? `<ol class="timeline">${t.visits
            .map((v, i) => `<li class="reveal" style="--i:${i % 6}"><span class="tl-n">${i + 1}</span>
              <a class="tl-card" href="${visitHref(v)}">
                ${v.cover ? `<img src="${esc(v.cover)}" alt="" loading="lazy">` : '<span class="tl-nocover">📍</span>'}
                <span class="tl-body"><small>${esc(formatRange(v.startDay, v.endDay))}</small><b>${esc(v.title)}</b>
                <span>${esc(placeShort(v.placeName))}${v.photoCount ? ` · 📷 ${v.photoCount}` : ''}${!isPublic && v.publishedAt ? ' · 🌎' : ''}${v.mine === false || (isPublic && v.author !== t.author) ? ` · @${esc(v.author)}` : ''}</span></span>
              </a></li>`)
            .join('')}</ol>`
        : `<div class="empty"><span>🧳</span><p>${isPublic ? 'Este viaje todavía no tiene visitas publicadas.' : 'Este viaje todavía no tiene visitas. En cada visita, elige este viaje en «🧳 Viaje».'}</p></div>`}
      ${isPublic ? `<p class="article-foot note">Viaje publicado por @${esc(t.author)} en TravelTime. Solo se muestran las visitas que publicó.</p>` : ''}
    </div>`;
  const io = reveal(el);

  // La ruta: un punto numerado por visita, unidos en orden.
  let map = null;
  if (t.visits.length) {
    map = new maplibregl.Map({ container: 'trip-map', style: currentBasemap().url, attributionControl: { compact: true }, cooperativeGestures: true, dragRotate: false });
    map.on('load', async () => {
      const pts = await Promise.all(t.visits.map((v) => placePoint(v.placeId)));
      if (!map) return;
      const route = pts.filter(Boolean);
      if (route.length > 1) {
        map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: route }, properties: {} } });
        map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#f2545b', 'line-width': 3, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.85 } });
      }
      const b = new maplibregl.LngLatBounds();
      pts.forEach((p, i) => {
        if (!p) return;
        const dot = document.createElement('a');
        dot.className = 'route-dot';
        dot.href = visitHref(t.visits[i]);
        dot.textContent = String(i + 1);
        dot.title = t.visits[i].title;
        new maplibregl.Marker({ element: dot }).setLngLat(p).addTo(map);
        b.extend(p);
      });
      if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 9, duration: 0 });
    });
  }
  page.cleanup = () => (io?.disconnect(), map?.remove(), (map = null));

  el.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-invite-form]');
    if (!form) return;
    e.preventDefault();
    const name = form.name.value.trim().replace(/^@/, '');
    if (!name) return;
    if (!(await ask({ title: `¿Invitar a @${name}?`, text: `Si acepta, verá todas las visitas de «${t.title}», con sus fotos y lugares (sin el GPS de las fotos), y podrá sumar las suyas.`, ok: 'Invitar' }))) return;
    try {
      await api('trips', { method: 'POST', query: { id: t.id, invite: 1 }, body: { name } });
      toast(`Invitación enviada a @${name}. La verá al entrar.`);
      renderTrip(id, { go, isPublic });
    } catch (ex) {
      toast(ex.message, 'err');
    }
  });

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-share]')) {
      try {
        if (navigator.share) await navigator.share({ title: t.title, url: location.href });
        else await navigator.clipboard.writeText(location.href), toast('Enlace copiado.');
      } catch {}
      return;
    }
    if (isPublic) return;
    const rerender = () => renderTrip(id, { go, isPublic });
    const remove = e.target.closest('[data-member-remove]');
    if (remove) {
      const name = remove.dataset.memberRemove;
      if (!(await ask({ title: `¿Sacar a @${name} del viaje?`, text: `Dejará de ver las visitas del viaje. Sus propias visitas siguen siendo suyas: solo salen de este viaje.`, ok: 'Sacar', danger: true }))) return;
      try {
        await api('trips', { method: 'DELETE', query: { id: t.id, member: name } });
        toast(`@${name} ya no está en el viaje.`);
        rerender();
      } catch (ex) {
        toast(ex.message, 'err');
      }
      return;
    }
    if (e.target.closest('[data-member-leave]')) {
      if (!(await ask({ title: '¿Salir de este viaje?', text: 'Dejarás de ver las visitas de los demás. Las tuyas siguen siendo tuyas: solo salen de este viaje.', ok: 'Salir', danger: true }))) return;
      try {
        await api('trips', { method: 'DELETE', query: { id: t.id, member: account.current().name } });
        toast('Saliste del viaje.');
        changed();
        go(null);
      } catch (ex) {
        toast(ex.message, 'err');
      }
      return;
    }
    if (t.role !== 'owner') return; // lo de abajo es solo del dueño (el servidor igual lo rechaza)
    if (e.target.closest('[data-trip-edit]')) {
      const saved = await tripForm(t);
      if (saved) renderTrip(id, { go, isPublic });
      return;
    }
    const pub = e.target.closest('[data-trip-publish]');
    if (pub) {
      const on = pub.dataset.tripPublish === '1';
      if (on && !(await ask({ title: '¿Publicar este viaje?', text: 'Lo verá cualquiera, con su mapa y su línea de tiempo. Solo aparecen las visitas que ya publicaste: de las privadas no se muestra nada, ni sus fechas ni sus lugares. El nombre y el resumen del viaje sí se ven tal como los escribiste.', ok: 'Publicar' }))) return;
      try {
        await api('trips', { method: 'PUT', query: { id: t.id, publish: 1 }, body: { published: on } });
        toast(on ? 'Viaje publicado.' : 'El viaje ya no está publicado.');
        renderTrip(id, { go, isPublic });
      } catch (ex) {
        toast(ex.message, 'err');
      }
      return;
    }
    if (e.target.closest('[data-trip-delete]')) {
      if (!(await ask({ title: `¿Borrar «${t.title}»?`, text: 'Se borra el viaje, no sus visitas: esas quedan como estaban, sueltas.', ok: 'Borrar viaje', danger: true }))) return;
      try {
        await api('trips', { method: 'DELETE', query: { id: t.id } });
        toast('Viaje borrado.');
        changed();
        go(null);
      } catch (ex) {
        toast(ex.message, 'err');
      }
    }
  });
}

// Compañeros del viaje: el dueño invita y saca; un compañero puede salirse.
function membersHtml(t) {
  const me = account.current()?.name;
  const owner = t.role === 'owner';
  const chips = t.members
    .map((m) => {
      const label = m.role === 'owner' ? 'creó el viaje' : m.status === 'invited' ? 'invitación enviada' : 'compañero';
      const remove = owner && m.role !== 'owner'
        ? `<button class="link danger-link" data-member-remove="${esc(m.name)}" aria-label="Sacar a @${esc(m.name)}">✕</button>`
        : !owner && m.name === me ? '<button class="link danger-link" data-member-leave>Salir del viaje</button>' : '';
      return `<li class="member ${m.status === 'invited' ? 'pending' : ''}"><span class="avatar-sm">${esc(m.name.charAt(0).toUpperCase())}</span><span><b>@${esc(m.name)}</b><small>${label}</small></span>${remove}</li>`;
    })
    .join('');
  return `<section class="members"><h2>Compañeros</h2><ul class="member-list">${chips}</ul>
    ${owner ? `<form class="invite-form" data-invite-form><input name="name" placeholder="@usuario de tu compañero" autocomplete="off" autocapitalize="none" required aria-label="Usuario a invitar"><button class="primary small">Invitar</button></form>
      <p class="note">Quien acepte verá todas las visitas de este viaje (con sus fotos y lugares, sin el GPS de las fotos) y podrá sumar las suyas. No podrá cambiar las tuyas ni el viaje.</p>` : ''}</section>`;
}

// Nombre y resumen de un viaje. Sin trip: uno nuevo (con visitId, la mete de una vez).
// Devuelve el viaje guardado o null.
export function tripForm(trip = null, { visitId } = {}) {
  return new Promise((resolve) => {
    let saved = null;
    const { root, close } = modal(
      `<h2>${trip ? 'Editar viaje' : 'Nuevo viaje'}</h2>
       <form data-trip-form>
         <label class="field"><span>Nombre</span><input name="title" maxlength="120" required autofocus value="${esc(trip?.title ?? '')}" placeholder="Centroamérica, Semana Santa 2025"></label>
         <label class="field"><span>De qué se trató (opcional)</span><textarea name="summary" rows="3" maxlength="2000" placeholder="Diez días en bus de Managua a San José…">${esc(trip?.summary ?? '')}</textarea></label>
         <p class="form-error" hidden></p>
         <div class="actions"><button type="button" class="secondary" data-close>Cancelar</button><button class="primary">${trip ? 'Guardar' : 'Crear viaje'}</button></div>
       </form>`,
      { label: trip ? 'Editar viaje' : 'Nuevo viaje', onClose: () => resolve(saved) },
    );
    root.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      const err = e.target.querySelector('.form-error');
      err.hidden = true;
      try {
        saved = trip
          ? (await api('trips', { method: 'PUT', query: { id: trip.id }, body: data })).trip
          : (await api('trips', { method: 'POST', body: { ...data, visitId } })).trip;
        changed();
        close();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}

// ---------- Visita publicada ----------

export async function renderPublicVisit(id, { go, openViewer }) {
  const el = openPage('article');
  el.innerHTML = '<div class="article-loading"><div class="spinner"></div></div>';
  let v;
  try {
    v = (await api('public', { query: { visit: id } })).visit;
  } catch (e) {
    el.innerHTML = `<div class="article-missing"><span>🗺️</span><h2>${esc(e.status === 404 ? 'Esta visita no existe o ya no está publicada' : 'No se pudo abrir')}</h2><p class="note">${esc(e.status === 404 ? 'Puede que su autor la haya dejado de publicar.' : e.message)}</p><a class="primary" href="#/">Ir al inicio</a></div>`;
    return;
  }
  if (page?.el !== el) return;
  const me = account.current();
  const mine = me && me.name === v.author;
  const photos = new Map(v.photos.filter((p) => p.urls).map((p) => [p.id, p]));
  const pins = new Map(v.pins.map((p) => [p.id, p]));
  const cover = v.photos.find((p) => p.urls);
  el.innerHTML = `
    <header class="article-hero ${cover ? 'has-cover' : ''}">
      ${cover ? `<img class="article-cover" src="${esc(cover.urls.full)}" alt="">` : ''}
      <div class="article-bar"><a class="glass-btn" href="#/" aria-label="Inicio">←</a><span><button class="glass-btn" data-print title="Guardar como PDF o imprimir">PDF</button> <button class="glass-btn" data-share>Compartir</button></span></div>
      <div class="article-title wrap-narrow">
        <p class="eyebrow">📍 ${esc(v.placeName ?? '')}</p>
        <h1>${esc(v.title)}</h1>
        <p class="article-meta"><a class="author-link" href="#/u/${esc(v.author)}">${authorLine(v.author, v.authorAvatar)}</a> · ${esc(formatRange(v.startDay, v.endDay))}${v.trip ? ` · 🧳 <a class="trip-link" href="#/t/${v.trip.id}">${esc(v.trip.title)}</a>` : ''}</p>
      </div>
    </header>
    <div class="article-body wrap-narrow">
      ${mine ? `<div class="owner-note">Es tu visita, publicada. <a href="#/${esc(v.placeId)}/v/${v.id}">Abrirla en tu mapa</a></div>` : ''}
      <div class="article-actions">
        <button class="primary" data-want-place>♡ Quiero ir a ${esc((v.placeName ?? '').split(',')[0])}</button>
        <a class="secondary" href="#/${esc(v.placeId)}">Ver en el mapa</a>
      </div>
      <article class="story big">${renderStory(v.body, { photos, pins }) || '<p class="note">Sin relato.</p>'}</article>
      ${v.pins.length ? `<section class="article-section"><h2>Lugares</h2><div class="mini-map" id="mini-map"></div>
        <ul class="article-pins">${v.pins
          .map((p) => {
            const k = kindOf(p.kind);
            return `<li style="--k:${k.color}"><button class="article-pin" data-pin-focus-mini="${p.id}"><span class="pin-emoji">${k.emoji}</span><span><b>${esc(p.name)}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}</span></button>
              <div class="place-chip-actions"><button class="chip-btn" data-want-pin="${p.id}">♡ Quiero ir</button><button class="chip-btn" data-been-pin="${p.id}" data-been-title="${esc(p.name)}">✓ Estuve</button></div></li>`;
          })
          .join('')}</ul></section>` : ''}
      ${photos.size ? `<section class="article-section"><h2>Fotos</h2><div class="article-grid">${[...photos.values()]
        .map((p, i) => `<button class="tile" data-public-photo="${i}"><img src="${esc(p.urls.thumb)}" alt="${esc(p.caption ?? '')}" loading="lazy"></button>`)
        .join('')}</div></section>` : ''}
      <p class="article-foot note">Publicado por @${esc(v.author)} en TravelTime. De sus lugares solo se copia la ubicación si los guardas.</p>
    </div>`;

  // Mapa chico con los lugares
  let mini = null;
  if (v.pins.length) {
    mini = new maplibregl.Map({
      container: 'mini-map',
      style: currentBasemap().url,
      attributionControl: { compact: true },
      cooperativeGestures: true,
      dragRotate: false,
    });
    mini.on('load', () => {
      const b = new maplibregl.LngLatBounds();
      for (const p of v.pins) {
        const k = kindOf(p.kind);
        const dot = document.createElement('div');
        dot.className = 'mini-dot';
        dot.style.setProperty('--k', k.color);
        dot.title = p.name;
        new maplibregl.Marker({ element: dot }).setLngLat([p.lng, p.lat]).setPopup(new maplibregl.Popup({ offset: 12, className: 'pin-popup' }).setHTML(`<div class="pin-card"><span class="pin-kind" style="--k:${k.color}">${k.emoji} ${esc(k.label)}</span><strong>${esc(p.name)}</strong></div>`)).addTo(mini);
        b.extend([p.lng, p.lat]);
      }
      mini.fitBounds(b, { padding: 50, maxZoom: 15, duration: 0 });
    });
  }
  page.cleanup = () => mini?.remove();

  const viewerPhotos = [...photos.values()];
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-share]')) {
      const url = location.href;
      try {
        if (navigator.share) await navigator.share({ title: v.title, url });
        else {
          await navigator.clipboard.writeText(url);
          toast('Enlace copiado.');
        }
      } catch {}
      return;
    }
    // PDF: el dialogo de imprimir del navegador ("Guardar como PDF"). Las fotos
    // se cargan antes de abrirlo: con loading=lazy, las de abajo saldrian en blanco.
    if (e.target.closest('[data-print]')) {
      const imgs = [...el.querySelectorAll('.article-body img, .article-cover')];
      imgs.forEach((img) => (img.loading = 'eager'));
      await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
      print();
      return;
    }
    if (e.target.closest('[data-want-place]')) return wantToGo({ placeId: v.placeId, placeName: v.placeName, visitId: v.id });
    const want = e.target.closest('[data-want-pin]');
    if (want) {
      const w = await wantToGo({ pinId: Number(want.dataset.wantPin) });
      if (w) want.classList.add('done'), (want.textContent = '♥ En tu lista');
      return;
    }
    const been = e.target.closest('[data-been-pin]');
    if (been) return beenThere({ pinId: Number(been.dataset.beenPin), title: been.dataset.beenTitle, go });
    const focus = e.target.closest('[data-pin-focus], [data-pin-focus-mini]');
    if (focus && mini) {
      const p = pins.get(Number(focus.dataset.pinFocus ?? focus.dataset.pinFocusMini));
      el.querySelector('#mini-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      mini.flyTo({ center: [p.lng, p.lat], zoom: 16 });
      return;
    }
    const ph = e.target.closest('[data-public-photo], [data-story-photo]');
    if (ph) {
      const i = ph.dataset.publicPhoto != null ? Number(ph.dataset.publicPhoto) : viewerPhotos.findIndex((p) => p.id === Number(ph.dataset.storyPhoto));
      if (i >= 0) openViewer(viewerPhotos, i);
    }
  });
}

// ---------- Perfil (mio en #/perfil, de otro en #/u/moim16) ----------

const sinceText = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('es', { month: 'long', year: 'numeric' }) : null;
};

function aboutHtml(p, mine) {
  const a = p.about ?? {};
  const rows = [
    a.livesIn && ['🏠', 'Vive en', esc(a.livesIn)],
    a.languages?.length && ['🗣️', 'Habla', esc(a.languages.join(', '))],
    a.dream && ['✨', 'Sueña con ir a', esc(a.dream)],
    sinceText(p.since) && ['🧳', 'En TravelTime desde', esc(sinceText(p.since))],
  ].filter(Boolean);
  const chips = (a.interests ?? []).map((k) => INTERESTS[k]).filter(Boolean);
  const empty = !a.bio && !rows.length && !chips.length;
  return `
    ${a.bio ? `<div class="pf-bio reveal">${esc(a.bio).replace(/\n/g, '<br>')}</div>` : ''}
    ${rows.length ? `<ul class="pf-facts">${rows.map(([i, k, v], n) => `<li class="reveal" style="--i:${n}"><span class="pf-ico">${i}</span><span><small>${k}</small><b>${v}</b></span></li>`).join('')}</ul>` : ''}
    ${chips.length ? `<h3 class="pf-h reveal">Le gusta viajar por</h3><div class="pf-chips">${chips.map((c, n) => `<span class="pf-chip reveal" style="--i:${n % 8}">${c.emoji} ${esc(c.label)}</span>`).join('')}</div>` : ''}
    ${empty ? `<div class="empty reveal"><span>👋</span><p>${mine ? 'Cuéntale al mundo quién eres: dónde vives, qué idiomas hablas y cómo te gusta viajar.' : 'Todavía no escribió nada sobre sí.'}</p>${mine ? '<button class="primary" data-edit-profile>Completar mi perfil</button>' : ''}</div>` : ''}`;
}

export async function renderProfile(name, { go }) {
  const el = openPage('article profile-page');
  el.innerHTML = '<div class="article-loading"><div class="spinner"></div></div>';
  const me = account.current();
  const mine = !name || (me && me.name.toLowerCase() === name.toLowerCase());
  if (mine && !me) {
    el.innerHTML = `<div class="article-missing"><span>🧭</span><h2>Entra para ver tu perfil</h2><button class="primary" data-auth="login">Entrar con Google</button></div>`;
    return;
  }
  let p;
  let visits = [];
  try {
    const r = await api('public', { query: { user: mine ? me.name : name } });
    visits = r.visits;
    // El mio sale de "me": trae las cifras privadas (marcas, visitas sin publicar).
    p = mine ? { ...r.profile, ...me, about: me.about, stats: me.stats, verified: me.hasGoogle } : r.profile;
  } catch (e) {
    el.innerHTML = `<div class="article-missing"><span>🧭</span><h2>${esc(e.status === 404 ? 'Este viajero no existe' : 'No se pudo abrir')}</h2><a class="primary" href="#/">Ir al inicio</a></div>`;
    return;
  }
  if (page?.el !== el) return;
  const s = p.stats ?? {};
  const stats = mine
    ? [[s.countries, s.countries === 1 ? 'país' : 'países'], [s.cities, s.cities === 1 ? 'ciudad' : 'ciudades'], [s.visits, s.visits === 1 ? 'visita' : 'visitas'], [s.photos, 'fotos'], [s.published, s.published === 1 ? 'publicada' : 'publicadas'], [s.wishes, 'quiero ir']]
    : [[s.published, s.published === 1 ? 'historia' : 'historias'], [s.countries, s.countries === 1 ? 'país' : 'países'], [s.photos, 'fotos']];
  const display = p.fullName || p.name;
  el.innerHTML = `
    <div class="pf-top"><button class="glass-btn" data-back aria-label="Volver">←</button>
      ${mine ? '<button class="glass-btn" data-edit-profile>✎ Editar perfil</button>' : '<button class="glass-btn" data-share>Compartir</button>'}</div>
    <div class="pf-wrap">
      <aside class="pf-card reveal">
        <div class="pf-av">${avatarHtml(p.avatar, display, 'avatar-xl')}${p.verified ? '<span class="pf-verified" title="Entra con Google">✓</span>' : ''}</div>
        <h1>${esc(display)}</h1>
        <p class="pf-handle">@${esc(p.name)}${p.about?.livesIn ? ` · ${esc(p.about.livesIn)}` : ''}</p>
        <div class="pf-stats">${stats.map(([n, l], i) => `<div class="reveal" style="--i:${i}"><b data-count="${Number(n) || 0}">0</b><span>${l}</span></div>`).join('')}</div>
        ${p.verified ? '<p class="pf-badge">🛡️ Identidad confirmada con Google</p>' : ''}
        ${mine ? '<p class="note pf-private">Las cifras de visitas, fotos y "quiero ir" solo las ves tú. Tu perfil público muestra lo que publicas y tu "Sobre mí".</p>' : ''}
        ${mine ? `<a class="link" href="#/u/${esc(p.name)}">Ver cómo lo ven los demás →</a>` : ''}
      </aside>
      <section class="pf-main">
        <p class="eyebrow reveal">Sobre ${mine ? 'mí' : esc(display.split(' ')[0])}</p>
        <h2 class="reveal">${mine ? 'Tu perfil de viajero' : `Hola, soy ${esc(display.split(' ')[0])}`}</h2>
        ${aboutHtml(p, mine)}
        <p class="eyebrow reveal pf-sep">Historias</p>
        <h2 class="reveal">${visits.length ? `Lo que ${mine ? 'publicaste' : 'contó'}` : 'Sin historias publicadas'}</h2>
        ${visits.length
          ? `<div class="rec-grid">${visits.map(cardHtml).join('')}</div>`
          : `<div class="empty reveal"><span>📖</span><p>${mine ? 'Cuando publiques una visita, aparece aquí y en la portada.' : 'Cuando publique una visita, aparece aquí.'}</p></div>`}
      </section>
    </div>`;
  const io = reveal(el);
  // Las cifras suben desde 0, como un contador.
  const counters = [...el.querySelectorAll('[data-count]')];
  const t0 = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  const tick = (t) => {
    const k = reduce ? 1 : Math.min(1, (t - t0) / 900);
    const ease = 1 - (1 - k) ** 3;
    counters.forEach((c) => (c.textContent = String(Math.round(Number(c.dataset.count) * ease))));
    if (k < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  page.cleanup = () => (io?.disconnect(), cancelAnimationFrame(raf));

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-back]')) return history.length > 1 ? history.back() : go(null);
    if (e.target.closest('[data-edit-profile]')) return account.openAccount();
    if (e.target.closest('[data-share]')) {
      const url = location.href;
      try {
        if (navigator.share) await navigator.share({ title: `${display} en TravelTime`, url });
        else {
          await navigator.clipboard.writeText(url);
          toast('Enlace copiado ✓');
        }
      } catch {}
    }
  });
}
