// "Tu año en viajes" (#/anio y #/anio/2025): el resumen del año en pantallas
// que avanzan solas, como historias. Tocar a la derecha adelanta, a la
// izquierda vuelve, mantener apretado pausa. La ultima es la tarjeta para compartir.
//
// Los datos salen de GET /api/visits?wrapped=AÑO (api/_lib/wrapped.js). Los
// kilometros se suman aqui, con el punto de cada lugar (geo.placePoint).

import { api } from './api.js';
import * as account from './account.js';
import { esc, toast } from './ui.js';
import { openPage, onLeave } from './pages.js';
import { avatarHtml } from './avatar.js';
import * as geo from './geo.js';

const SLIDE_MS = 6500;
const EARTH_KM = 40075;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MON = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180;
  const h = Math.sin(((d - b) * r) / 2) ** 2 + Math.cos(b * r) * Math.cos(d * r) * Math.sin(((c - a) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
// Con punto de miles tambien en 4 cifras (5.470): en es, por norma, no se agrupan.
const fmt = (n) => Math.round(n).toLocaleString('es', { useGrouping: 'always' });

export async function renderWrapped(year, { go }) {
  const el = openPage('wrapped');
  const me = account.current();
  if (!me) {
    el.innerHTML = `<div class="article-missing"><span>🎆</span><h2>Entra para ver tu año en viajes</h2><button class="primary" data-auth="login">Entrar con Google</button></div>`;
    return;
  }
  el.innerHTML = '<div class="article-loading"><div class="spinner"></div></div>';
  let data;
  try {
    data = await api('visits', { query: { wrapped: year ?? '' } });
  } catch (e) {
    el.innerHTML = `<div class="article-missing"><span>🎆</span><h2>${esc(e.message)}</h2><a class="primary" href="#/">Ir al inicio</a></div>`;
    return;
  }
  const w = data.wrapped;
  const names = new Map((await geo.world()).features.map((f) => [f.properties.iso, f.properties.name]));

  // Kilometros: de visita en visita, en orden de fecha (las que tienen fecha).
  const dated = w.visits.filter((v) => v.startDay);
  const pts = (await Promise.all(dated.map((v) => geo.placePoint(v.placeId)))).filter(Boolean);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += km(pts[i - 1], pts[i]);

  const empty = !w.visits.length && !w.places;
  const topMonth = w.months.indexOf(Math.max(...w.months));
  const slides = empty
    ? [slideEmpty(w, data.years)]
    : [
        slideIntro(w, me),
        slideCountries(w, names),
        slidePlaces(w, names),
        ...(pts.length > 1 ? [slideKm(total, pts)] : []),
        ...(w.travelDays ? [slideTime(w, topMonth)] : []),
        ...(w.mosaic.length ? [slideMosaic(w)] : []),
        ...(w.companions.length || w.trips.length ? [slidePeople(w)] : []),
        ...(w.longest && w.longest.days > 1 ? [slideLongest(w)] : []),
        slideSummary(w, me, total, names, data.years),
      ];

  el.innerHTML = `
    <div class="wr-bars">${slides.map(() => '<span><i></i></span>').join('')}</div>
    <button class="wr-close glass-btn" data-wr-close aria-label="Cerrar">✕</button>
    <div class="wr-stage">${slides.map((s, i) => `<section class="wr-slide ${s.theme}" data-i="${i}">${s.html}</section>`).join('')}</div>`;

  let at = 0;
  let timer = null;
  let started = 0;
  let left = SLIDE_MS;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bars = [...el.querySelectorAll('.wr-bars i')];
  const show = (i) => {
    at = Math.max(0, Math.min(slides.length - 1, i));
    el.querySelectorAll('.wr-slide').forEach((s, n) => s.classList.toggle('on', n === at));
    bars.forEach((b, n) => {
      b.style.transition = 'none';
      b.style.width = n < at ? '100%' : '0%';
    });
    const slide = el.querySelector(`.wr-slide[data-i="${at}"]`);
    // Los numeros suben desde 0 cada vez que la pantalla aparece.
    slide.querySelectorAll('[data-count]').forEach((c) => countUp(c, Number(c.dataset.count), reduce));
    left = SLIDE_MS;
    play();
  };
  const play = () => {
    clearTimeout(timer);
    if (at >= slides.length - 1) {
      bars[at].style.width = '100%';
      return; // la ultima se queda
    }
    started = performance.now();
    requestAnimationFrame(() => {
      bars[at].style.transition = `width ${left}ms linear`;
      bars[at].style.width = '100%';
    });
    timer = setTimeout(() => show(at + 1), left);
  };
  const pause = () => {
    clearTimeout(timer);
    left = Math.max(400, left - (performance.now() - started));
    const b = bars[at];
    b.style.transition = 'none';
    b.style.width = `${b.getBoundingClientRect().width / b.parentElement.getBoundingClientRect().width * 100}%`;
  };

  const stage = el.querySelector('.wr-stage');
  let pressAt = 0;
  stage.addEventListener('pointerdown', () => {
    pressAt = performance.now();
    pause();
  });
  stage.addEventListener('pointerup', (e) => {
    if (e.target.closest('button, a, select')) return play();
    // Apretar largo es pausa: al soltar sigue donde estaba.
    if (performance.now() - pressAt > 350) return play();
    const r = stage.getBoundingClientRect();
    show(e.clientX - r.left < r.width * 0.3 ? at - 1 : at + 1);
  });
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') show(at + 1);
    else if (e.key === 'ArrowLeft') show(at - 1);
    else if (e.key === 'Escape') history.length > 1 ? history.back() : go(null);
  };
  addEventListener('keydown', onKey);
  el.querySelector('[data-wr-close]').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-wr-year]')) location.hash = `#/anio/${e.target.value}`;
  });
  el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-wr-share]')) return;
    const text = `Mi ${w.year} en viajes: ${w.countries.length} ${w.countries.length === 1 ? 'país' : 'países'}, ${w.cities} ${w.cities === 1 ? 'ciudad' : 'ciudades'}${total > 0 ? `, ${fmt(total)} km` : ''}${w.travelDays ? ` y ${w.travelDays} días de viaje` : ''}. 🌎 TravelTime`;
    try {
      if (navigator.share) await navigator.share({ title: `Mi ${w.year} en viajes`, text, url: `${location.origin}/#/u/${me.name}` });
      else {
        await navigator.clipboard.writeText(text);
        toast('Copiado: pégalo donde quieras ✓');
      }
    } catch {}
  });
  show(0);
  onLeave(() => {
    clearTimeout(timer);
    removeEventListener('keydown', onKey);
  });
}

function countUp(el, to, reduce) {
  const t0 = performance.now();
  const dur = reduce ? 0 : 1300;
  const step = (t) => {
    const k = dur ? Math.min(1, (t - t0) / dur) : 1;
    el.textContent = fmt(to * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- Las pantallas ----------

function slideIntro(w, me) {
  return {
    theme: 'th-sunset',
    html: `<div class="wr-c">
      <div class="wr-av">${avatarHtml(me.avatar, me.fullName || me.name, 'avatar-xl')}</div>
      <p class="wr-kicker">Hola, ${esc((me.fullName || me.name).split(' ')[0])}</p>
      <h1 class="wr-year"><span>${w.year}</span></h1>
      <p class="wr-big">en viajes</p>
      <p class="wr-hint">Toca para seguir →</p></div>`,
  };
}

function slideCountries(w, names) {
  return {
    theme: 'th-ocean',
    html: `<div class="wr-c">
      <p class="wr-kicker">Este año pisaste</p>
      <p class="wr-num"><b data-count="${w.countries.length}">0</b></p>
      <p class="wr-big">${w.countries.length === 1 ? 'país' : 'países'}</p>
      <div class="wr-chips">${w.countries.map((c, i) => `<span style="--i:${i}">${esc(names.get(c) ?? c)}</span>`).join('')}</div></div>`,
  };
}

function slidePlaces(w, names) {
  const top = w.topCountry;
  return {
    theme: 'th-forest',
    html: `<div class="wr-c">
      <div class="wr-row">
        <div><p class="wr-num"><b data-count="${w.cities}">0</b></p><p class="wr-label">${w.cities === 1 ? 'ciudad' : 'ciudades'}</p></div>
        <div><p class="wr-num"><b data-count="${w.visits.length}">0</b></p><p class="wr-label">${w.visits.length === 1 ? 'visita' : 'visitas'}</p></div>
      </div>
      ${top ? `<p class="wr-kicker">Donde más volviste</p><p class="wr-big">${esc(names.get(top.iso) ?? top.iso)}</p><p class="wr-label">${top.visits} ${top.visits === 1 ? 'visita' : 'visitas'}</p>` : ''}
    </div>`,
  };
}

function slideKm(total, pts) {
  // La ruta dibujada: los puntos en una caja de 300x200 (equirectangular), y la
  // linea se va trazando con stroke-dashoffset.
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const [w0, e0, s0, n0] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const span = Math.max(e0 - w0, n0 - s0, 0.5);
  const x = (lon) => 20 + ((lon - w0) / span) * 260;
  const y = (lat) => 180 - ((lat - s0) / span) * 160;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const laps = total / EARTH_KM;
  return {
    theme: 'th-night',
    html: `<div class="wr-c">
      <p class="wr-kicker">Recorriste</p>
      <p class="wr-num"><b data-count="${Math.round(total)}">0</b><small> km</small></p>
      <svg class="wr-route" viewBox="0 0 300 200" aria-hidden="true">
        <path d="${d}" pathLength="1" />
        ${pts.map((p, i) => `<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="5" style="--i:${i}" />`).join('')}
      </svg>
      <p class="wr-label">${laps >= 1 ? `¡${laps.toFixed(1)} vueltas al mundo!` : `${Math.max(1, Math.round(laps * 100))}% de una vuelta al mundo`}</p></div>`,
  };
}

function slideTime(w, topMonth) {
  const max = Math.max(1, ...w.months);
  return {
    theme: 'th-amber',
    html: `<div class="wr-c">
      <p class="wr-kicker">Estuviste de viaje</p>
      <p class="wr-num"><b data-count="${w.travelDays}">0</b></p>
      <p class="wr-big">${w.travelDays === 1 ? 'día' : 'días'}</p>
      <div class="wr-months">${w.months.map((n, i) => `<div style="--h:${(n / max) * 100}%;--i:${i}" class="${i === topMonth && n ? 'wr-top' : ''}"><i></i><span>${MON[i]}</span></div>`).join('')}</div>
      ${Math.max(...w.months) ? `<p class="wr-label">Tu mes más viajero: <b>${MONTHS[topMonth]}</b></p>` : ''}</div>`,
  };
}

function slideMosaic(w) {
  return {
    theme: 'th-violet',
    html: `<div class="wr-c">
      <div class="wr-mosaic">${w.mosaic.map((u, i) => `<img src="${esc(u)}" alt="" style="--i:${i}">`).join('')}</div>
      <div class="wr-row">
        <div><p class="wr-num"><b data-count="${w.photos}">0</b></p><p class="wr-label">fotos</p></div>
        <div><p class="wr-num"><b data-count="${w.pins}">0</b></p><p class="wr-label">lugares marcados</p></div>
      </div></div>`,
  };
}

function slidePeople(w) {
  return {
    theme: 'th-coral',
    html: `<div class="wr-c">
      ${w.trips.length ? `<p class="wr-kicker">${w.trips.length === 1 ? 'Tu viaje' : `Tus ${w.trips.length} viajes`}</p><div class="wr-chips">${w.trips.map((t, i) => `<span style="--i:${i}">🧳 ${esc(t.title)}</span>`).join('')}</div>` : ''}
      ${w.companions.length ? `<p class="wr-kicker">Viajaste con</p><div class="wr-chips">${w.companions.map((c, i) => `<span style="--i:${i + 3}">@${esc(c)}</span>`).join('')}</div>` : ''}
    </div>`,
  };
}

function slideLongest(w) {
  return {
    theme: 'th-ocean',
    html: `<div class="wr-c">
      <p class="wr-kicker">Tu escapada más larga</p>
      <p class="wr-num"><b data-count="${w.longest.days}">0</b></p><p class="wr-big">días</p>
      <p class="wr-label">«${esc(w.longest.title)}»${w.longest.placeName ? ` · ${esc(w.longest.placeName.split(',')[0])}` : ''}</p></div>`,
  };
}

function yearPicker(w, years) {
  return years.length > 1
    ? `<label class="wr-pick">Otro año <select data-wr-year>${years.map((y) => `<option ${y === w.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>`
    : '';
}

function slideSummary(w, me, total, names, years) {
  const stat = (n, l) => `<div><b>${fmt(n)}</b><span>${l}</span></div>`;
  return {
    theme: 'th-sunset',
    html: `<div class="wr-c">
      <div class="wr-card">
        <div class="wr-card-head">${avatarHtml(me.avatar, me.fullName || me.name, 'avatar-sm')}<span>@${esc(me.name)}</span><b>${w.year}</b></div>
        <p class="wr-card-title">Mi año en viajes</p>
        <div class="wr-card-grid">
          ${stat(w.countries.length, w.countries.length === 1 ? 'país' : 'países')}
          ${stat(w.cities, w.cities === 1 ? 'ciudad' : 'ciudades')}
          ${stat(total, 'km')}
          ${stat(w.travelDays, 'días')}
          ${stat(w.photos, 'fotos')}
          ${stat(w.visits.length, 'visitas')}
        </div>
        <p class="wr-card-list">${w.countries.slice(0, 8).map((c) => esc(names.get(c) ?? c)).join(' · ')}</p>
        <p class="wr-card-foot">✈ TravelTime</p>
      </div>
      <div class="wr-actions"><button class="primary" data-wr-share>Compartir</button>${yearPicker(w, years)}</div></div>`,
  };
}

function slideEmpty(w, years) {
  return {
    theme: 'th-night',
    html: `<div class="wr-c">
      <p class="wr-big">🎆</p><p class="wr-big">Tu ${w.year} todavía está en blanco</p>
      <p class="wr-label">Marca en el mapa los lugares donde estuviste o escribe una visita, y aquí aparece tu año.</p>
      <div class="wr-actions"><a class="primary" href="#/mundo">Ir al mapa</a>${yearPicker(w, years)}</div></div>`,
  };
}
