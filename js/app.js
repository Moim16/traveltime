// El mapa y el recorrido mundo -> pais -> departamento -> ciudad, y las visitas.
//
// La URL lleva solo el id mas profundo (#/NIC.granada.granada): los de arriba
// salen de el, asi que el boton atras del telefono funciona sin mas. Una visita
// cuelga del lugar: #/NIC.granada.granada/v/12, /v/12/editar, /v/nueva.

import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import * as geo from './geo.js';
import * as visits from './visits.js';
import * as account from './account.js';
import { api } from './api.js';
import { uploadAll } from './photos.js';
import { KINDS, kindOf, toGeoJSON, pinForm, pinCard } from './pins.js';
import { esc, toast, ask, busy, formatRange, paragraphs } from './ui.js';
import { BASEMAPS, currentBasemap, setBasemap, tintBasemap } from './basemap.js';

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const wide = matchMedia('(min-width: 820px)');

const WORLD_VIEW = [[-160, -50], [175, 72]];
const EMPTY = { type: 'FeatureCollection', features: [] };

// adm1: el primer nivel del pais abierto. cities: las ciudades del departamento abierto.
// visit: null (el lugar), 'new', o el id de una visita; edit: si se esta editando.
const state = { iso: null, adm1: null, city: null, adm1Data: null, cities: null, visit: null, edit: false };
const [world, countryIndex] = await Promise.all([geo.world(), geo.countries(), account.init()]);
if (account.current()) await visits.load().catch(() => {});
const countryName = new Map(world.features.map((f) => [f.properties.iso, f.properties.name]));

const map = new maplibregl.Map({
  container: 'map',
  style: currentBasemap().url,
  bounds: WORLD_VIEW,
  fitBoundsOptions: { padding: padding() },
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

// Lo que tapa el panel no cuenta como mapa visible.
function padding() {
  return wide.matches
    ? { top: 130, left: 410, right: 70, bottom: 50 }
    : { top: 120, left: 24, right: 24, bottom: Math.round(innerHeight * 0.46) + 16 };
}

// ---------- Capas ----------

function fillPaint() {
  const visited = ['boolean', ['feature-state', 'visited'], false];
  const hover = ['boolean', ['feature-state', 'hover'], false];
  const selected = ['boolean', ['feature-state', 'selected'], false];
  const va = parseFloat(css('--map-visited-alpha'));
  return {
    'fill-color': ['case', visited, css('--map-visited'), selected, css('--map-selected'), hover, css('--map-hover'), css('--map-idle')],
    // Lo elegido se nota por el borde grueso; con el relleno fuerte tapaba el
    // mapa justo donde uno quiere mirar.
    'fill-opacity': [
      'case',
      selected, ['case', visited, va, 0.22],
      visited, ['case', hover, va + 0.15, va],
      hover, parseFloat(css('--map-hover-alpha')),
      parseFloat(css('--map-idle-alpha')),
    ],
    'fill-opacity-transition': { duration: 250 },
    'fill-color-transition': { duration: 250 },
  };
}

function linePaint(width, opacity = 0.75) {
  const selected = ['boolean', ['feature-state', 'selected'], false];
  return {
    'line-color': ['case', selected, css('--map-selected'), css('--map-line')],
    'line-width': ['case', selected, width + 1.5, width],
    'line-opacity': opacity,
  };
}

function labelPoints() {
  const adm1 = state.adm1Data ? geo.labelPoints(state.adm1Data.features, 1) : [];
  const cities = state.cities ? geo.labelPoints(state.cities.features, 2) : [];
  return { type: 'FeatureCollection', features: [...adm1, ...cities] };
}

// Se llama al cargar y cada vez que cambia el estilo: setStyle borra las capas propias.
function addLayers() {
  tintBasemap(map, css);
  const beforeId = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('world', { type: 'geojson', data: world, promoteId: 'iso' });
  map.addSource('adm1', { type: 'geojson', data: state.adm1Data ?? EMPTY, promoteId: 'id' });
  map.addSource('city', { type: 'geojson', data: state.cities ?? EMPTY, promoteId: 'id' });
  map.addSource('labels', { type: 'geojson', data: labelPoints() });
  map.addLayer({ id: 'world-fill', type: 'fill', source: 'world', paint: fillPaint() }, beforeId);
  map.addLayer({ id: 'world-line', type: 'line', source: 'world', paint: linePaint(0.6, 0.5) }, beforeId);
  map.addLayer({ id: 'adm1-fill', type: 'fill', source: 'adm1', paint: fillPaint() }, beforeId);
  map.addLayer({ id: 'city-fill', type: 'fill', source: 'city', paint: fillPaint() }, beforeId);
  map.addLayer({ id: 'city-line', type: 'line', source: 'city', paint: linePaint(0.6, 0.6) }, beforeId);
  // El limite del pais abierto, con un halo suave: separa "adentro" de "afuera".
  map.addLayer({
    id: 'adm1-glow', type: 'line', source: 'adm1',
    paint: { 'line-color': css('--map-visited'), 'line-width': 6, 'line-blur': 5, 'line-opacity': 0.18 },
  }, beforeId);
  map.addLayer({ id: 'adm1-line', type: 'line', source: 'adm1', paint: linePaint(1.2) }, beforeId);
  // Nombres de las divisiones, encima de todo: las capas de simbolos de arriba se
  // colocan primero y le ganan el espacio a las del fondo, que rotulan ciudades
  // y esconden los nombres que no les caben.
  // Departamento en versalitas espaciadas y ciudad normal, como en un atlas.
  const level1 = ['==', ['get', 'level'], 1];
  map.addLayer({
    id: 'labels',
    type: 'symbol',
    source: 'labels',
    layout: {
      'text-field': ['case', level1, ['upcase', ['get', 'name']], ['get', 'name']],
      'text-font': ['case', level1, ['literal', ['Noto Sans Bold']], ['literal', ['Noto Sans Regular']]],
      'text-size': ['case', level1, 11, 12],
      'text-letter-spacing': ['case', level1, 0.12, 0],
      'text-max-width': 7,
      'text-padding': 2,
    },
    paint: {
      'text-color': ['case', level1, css('--muted'), css('--ink')],
      'text-halo-color': css('--halo'),
      'text-halo-width': 1.5,
    },
  });
  // Los lugares de las visitas, encima de todo: un punto por lugar, con el color
  // de su tipo y el nombre debajo cuando hay zoom para leerlo.
  map.addSource('pins', { type: 'geojson', data: toGeoJSON(pinsData), promoteId: 'id' });
  const big = ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'selected'], false]];
  map.addLayer({
    id: 'pins-dot',
    type: 'circle',
    source: 'pins',
    paint: {
      'circle-radius': ['case', big, 9, 6.5],
      'circle-color': ['match', ['get', 'kind'], ...Object.entries(KINDS).flatMap(([k, v]) => [k, v.color]), KINDS.other.color],
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
      'circle-radius-transition': { duration: 150 },
    },
  });
  map.addLayer({
    id: 'pins-label',
    type: 'symbol',
    source: 'pins',
    minzoom: 11,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['literal', ['Noto Sans Bold']],
      'text-size': 12,
      'text-anchor': 'top',
      'text-offset': [0, 0.9],
      'text-max-width': 9,
      'text-optional': true,
    },
    paint: { 'text-color': css('--ink'), 'text-halo-color': css('--halo'), 'text-halo-width': 1.6 },
  });
  // El globo en el mundo: se entiende de un vistazo donde queda cada cosa.
  map.setProjection({ type: 'globe' });
  applyFilters();
  applyStates();
}

function applyFilters() {
  // El pais abierto deja ver sus departamentos; el departamento abierto, sus ciudades.
  map.setFilter('world-fill', state.adm1Data ? ['!=', ['get', 'iso'], state.iso] : null);
  map.setFilter('adm1-fill', state.cities ? ['!=', ['get', 'id'], state.adm1] : null);
  // El nombre de lo elegido ya esta en el panel: en el mapa solo se encimaria
  // con el rotulo de la ciudad del fondo.
  const notChosen = ['!=', ['get', 'id'], state.city ?? state.adm1 ?? ''];
  map.setFilter(
    'labels',
    state.cities
      ? ['all', notChosen, ['any', ['==', ['get', 'level'], 2], ['!=', ['get', 'id'], state.adm1]]]
      : ['all', notChosen, ['==', ['get', 'level'], 1]],
  );
}

function applyStates() {
  for (const f of world.features) {
    map.setFeatureState({ source: 'world', id: f.properties.iso }, { visited: visits.has(f.properties.iso) });
  }
  for (const f of state.adm1Data?.features ?? []) {
    const id = f.properties.id;
    // Un departamento sin ciudades se elige el mismo: ahi se resalta.
    map.setFeatureState({ source: 'adm1', id }, { visited: visits.has(id), selected: !state.cities && id === state.adm1 });
  }
  for (const f of state.cities?.features ?? []) {
    const id = f.properties.id;
    map.setFeatureState({ source: 'city', id }, { visited: visits.has(id), selected: id === state.city });
  }
}

map.on('style.load', addLayers);

// ---------- Hover y click ----------

const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.append(tip);

const PICK = ['pins-dot', 'city-fill', 'adm1-fill', 'world-fill'];
const pick = (point) => map.queryRenderedFeatures(point, { layers: PICK.filter((l) => map.getLayer(l)) })[0];
const featureId = (f) => f.properties.id ?? f.properties.iso;
let hovered = null;

map.on('mousemove', (e) => {
  const f = pick(e.point);
  const key = f && { source: f.source, id: featureId(f) };
  if (hovered && (!key || hovered.id !== key.id || hovered.source !== key.source)) map.setFeatureState(hovered, { hover: false });
  hovered = key || null;
  map.getCanvas().style.cursor = picking ? 'crosshair' : f ? 'pointer' : '';
  if (!f || picking) return void (tip.hidden = true);
  map.setFeatureState(hovered, { hover: true });
  tip.textContent = f.properties.name;
  tip.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 14}px)`;
  tip.hidden = false;
});
map.getCanvas().addEventListener('mouseleave', () => {
  tip.hidden = true;
  if (hovered) map.setFeatureState(hovered, { hover: false });
  hovered = null;
});

map.on('click', (e) => {
  if (picking) return pickAt(e.lngLat.lat, e.lngLat.lng);
  const f = pick(e.point);
  if (!f) return;
  if (f.layer.id === 'pins-dot') return openPinPopup(Number(f.properties.id));
  go(featureId(f));
});

// ---------- Lugares (pines) ----------

let pinsData = [];
let pinsKey = '';
let popup = null;
// Modo "toca el mapa": { visitId } para uno nuevo, { visitId, pin } para mover uno.
let picking = null;

// Los pines a la vista: los de la visita abierta, o los de todo lo que hay
// dentro del lugar abierto. En el mundo, ninguno (serian demasiados puntos sueltos).
async function loadPins() {
  const key = !account.current() ? '' : typeof state.visit === 'number' ? `v${state.visit}` : here() ? `u${here()}` : '';
  pinsKey = key;
  let pins = [];
  if (key) {
    try {
      pins = (await api('pins', { query: key[0] === 'v' ? { visit: state.visit } : { under: here() } })).pins;
    } catch {
      pins = [];
    }
  }
  if (pinsKey !== key) return; // ya se fue a otro lado
  pinsData = pins;
  map.getSource('pins')?.setData(toGeoJSON(pinsData));
  renderPinList();
}

function openPinPopup(id, { fly: doFly = false } = {}) {
  const pin = pinsData.find((p) => p.id === id);
  if (!pin) return;
  popup?.remove();
  for (const p of pinsData) map.setFeatureState({ source: 'pins', id: p.id }, { selected: p.id === id });
  if (doFly) map.flyTo({ center: [pin.lng, pin.lat], zoom: Math.max(map.getZoom(), 15), padding: padding(), duration: 700 });
  popup = new maplibregl.Popup({ offset: 14, maxWidth: '290px', className: 'pin-popup' })
    .setLngLat([pin.lng, pin.lat])
    .setHTML(pinCard(pin, { inVisit: state.visit === pin.visitId }))
    .addTo(map);
  popup.on('close', () => map.getSource('pins') && map.setFeatureState({ source: 'pins', id }, { selected: false }));
}

function renderPinList() {
  const box = $('#pins');
  if (!box || typeof state.visit !== 'number') return;
  const mine = pinsData.filter((p) => p.visitId === state.visit);
  box.innerHTML =
    `<div class="visits-head"><h2>Lugares${mine.length ? ` <span class="count">${mine.length}</span>` : ''}</h2>` +
    `<button class="primary small" data-pin-add>+ Lugar</button></div>` +
    (mine.length
      ? '<ul class="pin-list">' +
        mine
          .map((p) => {
            const k = kindOf(p.kind);
            return `<li><button data-pin-focus="${p.id}"><span class="pin-emoji" style="--k:${k.color}">${k.emoji}</span><span><b>${esc(p.name)}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}</span></button></li>`;
          })
          .join('') +
        '</ul>'
      : '<p class="note">Marca dónde estuviste: el restaurante, el mirador, el hotel. Tocas el mapa, usas tu ubicación o lo sacas de una foto.</p>');
}

function startPicking(mode) {
  picking = mode;
  popup?.remove();
  document.body.classList.add('picking');
  const bar = document.createElement('div');
  bar.className = 'pick-bar glass';
  bar.id = 'pick-bar';
  bar.innerHTML = `<span>${mode.pin ? `Toca el mapa en la nueva ubicación de <b>${esc(mode.pin.name)}</b>` : 'Toca el mapa donde está el lugar'}</span>
    ${mode.pin ? '' : '<button class="secondary small" data-pick-here>Usar mi ubicación</button>'}
    <button class="link" data-pick-cancel>Cancelar</button>`;
  document.body.append(bar);
}

function stopPicking() {
  picking = null;
  document.body.classList.remove('picking');
  $('#pick-bar')?.remove();
}

async function pickAt(lat, lng) {
  const mode = picking;
  stopPicking();
  try {
    const pin = mode.pin
      ? (await api('pins', { method: 'PUT', query: { id: mode.pin.id }, body: { lat, lng } })).pin
      : await pinForm({ visitId: mode.visitId, lat, lng });
    if (!pin) return;
    toast(mode.pin ? 'Lugar movido.' : 'Lugar agregado.');
    await loadPins();
    openPinPopup(pin.id);
  } catch (ex) {
    toast(ex.message, 'err');
  }
}

function useMyLocation() {
  if (!navigator.geolocation) return toast('Este navegador no da la ubicación.', 'err');
  navigator.geolocation.getCurrentPosition(
    (pos) => pickAt(pos.coords.latitude, pos.coords.longitude),
    (err) => toast(err.code === 1 ? 'No diste permiso para usar tu ubicación.' : 'No se pudo obtener tu ubicación.', 'err'),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-pin-add]')) return startPicking({ visitId: state.visit });
  if (e.target.closest('[data-pick-cancel]')) return stopPicking();
  if (e.target.closest('[data-pick-here]')) return useMyLocation();
  const focus = e.target.closest('[data-pin-focus]');
  if (focus) return openPinPopup(Number(focus.dataset.pinFocus), { fly: true });
  const edit = e.target.closest('[data-pin-edit]');
  if (edit) {
    const pin = pinsData.find((p) => p.id === Number(edit.dataset.pinEdit));
    popup?.remove();
    if (pin && (await pinForm({ visitId: pin.visitId, lat: pin.lat, lng: pin.lng, pin }))) {
      toast('Lugar guardado.');
      await loadPins();
      openPinPopup(pin.id);
    }
    return;
  }
  const move = e.target.closest('[data-pin-move]');
  if (move) return startPicking({ visitId: state.visit, pin: pinsData.find((p) => p.id === Number(move.dataset.pinMove)) });
  const del = e.target.closest('[data-pin-delete]');
  if (del) {
    const pin = pinsData.find((p) => p.id === Number(del.dataset.pinDelete));
    if (!pin || !(await ask({ title: `¿Borrar «${pin.name}»?`, ok: 'Borrar', danger: true }))) return;
    try {
      await api('pins', { method: 'DELETE', query: { id: pin.id } });
      popup?.remove();
      toast('Lugar borrado.');
      await loadPins();
    } catch (ex) {
      toast(ex.message, 'err');
    }
  }
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && picking) stopPicking();
});

// ---------- Navegacion ----------

function go(path) {
  location.hash = path ? `#/${path}` : '#/';
}

const find = (fc, id) => fc?.features.filter((f) => (f.properties.id ?? f.properties.iso) === id) ?? [];

// "NIC.granada.granada/v/12/editar" -> { place, visit: 12, edit: true }
function parseRoute(hash) {
  const [place, v, id, action] = decodeURIComponent(hash.replace(/^#\/?/, '')).split('/');
  const visit = v === 'v' ? (id === 'nueva' ? 'new' : Number(id) || null) : null;
  return { place: place || null, visit, edit: visit === 'new' || action === 'editar' };
}

async function show({ place: id, visit, edit }) {
  const iso = id ? geo.isoOf(id) : null;
  if (iso && !countryName.has(iso)) return go(null);
  const parts = id ? id.split('.') : [];
  const info = iso ? countryIndex[iso] : null;
  const adm1Data = info ? await geo.country(iso) : null;
  const adm1 = parts.length >= 2 ? parts.slice(0, 2).join('.') : null;
  const adm1Feature = adm1 ? find(adm1Data, adm1)[0] : null;
  // Un id que ya no existe (mapa actualizado, enlace viejo): al nivel de arriba.
  if (adm1 && !adm1Feature) return go(iso);
  const cities = adm1Feature?.properties.cities ? await geo.cities(adm1) : null;
  const city = parts.length === 3 ? id : null;
  if (city && !find(cities, city).length) return go(adm1);

  const samePlace = state.iso === iso && state.adm1 === adm1 && state.city === city;
  Object.assign(state, { iso, adm1, city, adm1Data, cities, visit, edit });
  if (map.getSource('adm1') && !samePlace) {
    map.getSource('adm1').setData(adm1Data ?? EMPTY);
    map.getSource('city').setData(cities ?? EMPTY);
    map.getSource('labels').setData(labelPoints());
    applyFilters();
    applyStates();
  }
  // Abrir una visita no mueve el mapa: el lugar ya esta a la vista.
  if (!samePlace) fly();
  stopPicking();
  popup?.remove();
  renderCrumbs();
  renderPanel();
  loadPins();
}

function fly() {
  let target = [];
  if (state.city) target = find(state.cities, state.city);
  else if (state.adm1) target = find(state.adm1Data, state.adm1);
  else if (state.adm1Data) target = state.adm1Data.features;
  else if (state.iso) target = find(world, state.iso);
  // El mundo es el globo entero: encajar una caja lo deja diminuto en el centro.
  if (!target.length) {
    return map.flyTo({ center: [-40, 18], zoom: wide.matches ? 1.9 : 1.1, padding: padding(), duration: 900 });
  }
  map.fitBounds(geo.bbox(target), { padding: padding(), maxZoom: state.city ? 12.5 : state.adm1 ? 11 : 9, duration: 900 });
}

addEventListener('hashchange', () => show(parseRoute(location.hash)));

// ---------- Panel ----------

const labels = (iso) => countryIndex[iso]?.labels ?? ['Región', 'Ciudad'];
const plural = (w) => (/ón$/.test(w) ? w.replace(/ón$/, 'ones') : /z$/.test(w) ? w.replace(/z$/, 'ces') : w + 's').toLowerCase();
const nameOf = (id) => {
  if (!id) return '';
  const d = geo.depth(id);
  if (d === 0) return countryName.get(id);
  return find(d === 1 ? state.adm1Data : state.cities, id)[0]?.properties.name ?? id;
};

// El lugar abierto, el mas profundo de la ruta.
const here = () => state.city ?? state.adm1 ?? state.iso;
// Donde se escriben visitas: el ultimo nivel que existe para ese lugar.
const isLeaf = () => Boolean(state.city || (state.adm1 && !state.cities) || (state.iso && !state.adm1Data));
// "Granada, Granada, Nicaragua": se guarda con la visita para listarla sin mapas.
const placeName = () => [state.city, state.adm1, state.iso].filter(Boolean).map(nameOf).join(', ');

function renderCrumbs() {
  const chain = [null, state.iso, state.adm1, state.city].filter((x, i) => i === 0 || x);
  $('#crumbs').innerHTML = chain
    .map((id, i) => {
      const last = i === chain.length - 1 && !state.visit;
      const label = id ? nameOf(id) : 'Mundo';
      return `${i ? '<span aria-hidden="true">›</span>' : ''}<button data-go="${esc(id ?? '')}" ${last ? 'aria-current="page"' : ''}>${esc(label)}</button>`;
    })
    .join('');
}

function stat(label, done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="stat"><div class="stat-row"><span><b>${done}</b> de ${total} ${esc(label)}</span><span class="pct">${pct}%</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
}

function list(features) {
  const rows = [...features]
    .map((f) => f.properties)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
    .map((p) => {
      const on = visits.has(p.id);
      return `<li><button data-go="${esc(p.id)}"><span>${esc(p.name)}</span><span class="dot ${on ? 'on' : ''}" aria-label="${on ? 'visitado' : 'sin visitar'}"></span></button></li>`;
    });
  return `<ul class="list">${rows.join('')}</ul>`;
}

function toggleButton(id) {
  if (!account.current()) return `<button class="primary" data-login="Entra para marcar los lugares que visitaste.">Marcar como visitado</button>`;
  return visits.isMarked(id)
    ? `<button class="secondary" data-toggle="${esc(id)}">✓ Visitado · quitar</button>`
    : `<button class="primary" data-toggle="${esc(id)}">Marcar como visitado</button>`;
}

const kindLine = (text) => `<p class="kind">${esc(text)}</p>`;

function header() {
  const [l1, l2] = labels(state.iso);
  if (state.city) return kindLine(`${l2} · ${nameOf(state.adm1)}, ${nameOf(state.iso)}`) + `<h1>${esc(nameOf(state.city))}</h1>`;
  if (state.adm1) return kindLine(`${l1} · ${nameOf(state.iso)}`) + `<h1>${esc(nameOf(state.adm1))}</h1>`;
  return kindLine('País') + `<h1>${esc(nameOf(state.iso))}</h1>`;
}

function renderPanel() {
  const panel = $('#panel');
  panel.classList.toggle('tall', Boolean(state.visit));
  if (state.visit) return renderVisit(panel);

  const [l1, l2] = labels(state.iso);
  const info = countryIndex[state.iso];

  if (!state.iso) {
    const visited = world.features.filter((f) => visits.has(f.properties.iso));
    panel.innerHTML =
      kindLine('Mundo') + '<h1>Tu mapa</h1>' +
      (account.current()
        ? `<div class="big"><b>${visited.length}</b> ${visited.length === 1 ? 'país visitado' : 'países visitados'}</div>` +
          (visited.length ? list(visited.map((f) => ({ properties: { id: f.properties.iso, name: f.properties.name } }))) : '') +
          '<p class="note">Toca un país en el globo o búscalo arriba.</p>'
        : `<p class="note">Recorre el mundo, marca los lugares donde estuviste y escribe lo que hiciste en cada uno.</p>
           <div class="actions start"><button class="primary" data-auth="signup">Crear cuenta</button><button class="secondary" data-auth="login">Entrar</button></div>`);
    return;
  }

  let body = header();
  if (!isLeaf()) {
    if (!state.adm1) {
      body += stat(plural(l1), visits.countUnder(state.iso, 1), info.adm1);
      if (info.cities) body += stat(plural(l2), visits.countUnder(state.iso, 2), info.cities);
    } else {
      body += stat(plural(l2), visits.countUnder(state.adm1, 2), state.cities.features.length);
    }
  } else {
    body += toggleButton(here());
    if (state.iso && !state.adm1Data) body += '<p class="note">No hay divisiones de este país en los datos abiertos, así que se marca entero.</p>';
  }
  body += '<section id="visits" class="visits"></section>';
  if (!isLeaf()) body += list(state.adm1 ? state.cities.features : state.adm1Data.features);
  panel.innerHTML = body;
  renderVisitList();
}

// Las visitas del lugar abierto, o de todo lo que tiene adentro. Se piden aparte
// para que el panel aparezca sin esperar a la red.
async function renderVisitList() {
  const box = $('#visits');
  if (!box) return;
  const place = here();
  if (!account.current()) {
    if (isLeaf()) {
      box.innerHTML = `<div class="placeholder">Entra para escribir lo que hiciste en ${esc(nameOf(place))}: tu relato, las fotos y los lugares que marques.
        <div class="actions start"><button class="secondary" data-auth="login">Entrar</button></div></div>`;
    }
    return;
  }
  box.innerHTML = '<p class="note">Cargando tus visitas…</p>';
  let rows;
  try {
    rows = (await api('visits', { query: { under: place } })).visits;
  } catch (e) {
    if (here() === place) box.innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }
  if (here() !== place || state.visit) return; // ya se fue a otro lado
  const newBtn = isLeaf() ? `<button class="primary small" data-go="${esc(place)}/v/nueva">+ Nueva visita</button>` : '';
  const title = isLeaf() ? 'Tus visitas' : `Tus visitas en ${nameOf(place)}`;
  if (!rows.length) {
    box.innerHTML = isLeaf()
      ? `<div class="visits-head"><h2>${title}</h2>${newBtn}</div><p class="note">Todavía no escribiste nada de ${esc(nameOf(place))}.</p>`
      : '';
    return;
  }
  box.innerHTML =
    `<div class="visits-head"><h2>${esc(title)}</h2>${newBtn}</div><ul class="cards">` +
    rows
      .map(
        (v) => `<li><button class="card${v.cover ? ' with-cover' : ''}" data-go="${esc(v.placeId)}/v/${v.id}">
          ${v.cover ? `<img class="card-cover" src="${esc(v.cover)}" alt="" loading="lazy">` : ''}
          <span class="card-title">${esc(v.title)}</span>
          <span class="card-sub">${esc(formatRange(v.startDay, v.endDay))}${!isLeaf() && v.placeName ? ` · ${esc(v.placeName.split(',')[0])}` : ''}${v.photoCount ? ` · ${v.photoCount} ${v.photoCount === 1 ? 'foto' : 'fotos'}` : ''}</span>
        </button></li>`,
      )
      .join('') +
    '</ul>';
}

// Una visita abierta: verla, editarla o crearla.
async function renderVisit(panel) {
  const place = here();
  if (!account.current()) {
    go(place);
    account.openAuth('login', 'Entra para ver y escribir tus visitas.');
    return;
  }
  const back = `<button class="link back" data-go="${esc(place)}">← ${esc(nameOf(place))}</button>`;

  if (state.visit === 'new') return renderEditor(panel, back, null);

  panel.innerHTML = back + '<p class="note">Cargando…</p>';
  let v;
  try {
    v = (await api('visits', { query: { id: state.visit } })).visit;
  } catch (e) {
    panel.innerHTML = back + `<p class="note">${esc(e.status === 404 ? 'Esta visita no existe o no es tuya.' : e.message)}</p>`;
    return;
  }
  if (state.edit) return renderEditor(panel, back, v);

  panel.innerHTML =
    back +
    kindLine(formatRange(v.startDay, v.endDay)) +
    `<h1>${esc(v.title)}</h1>` +
    `<article class="story">${v.body ? paragraphs(v.body) : '<p class="note">Sin relato todavía.</p>'}</article>` +
    `<section class="gallery" id="gallery" aria-label="Fotos"></section>` +
    `<section class="pins" id="pins" aria-label="Lugares"></section>` +
    `<div class="actions start"><button class="secondary" data-go="${esc(place)}/v/${v.id}/editar">Editar</button>` +
    `<button class="danger-link" data-delete="${v.id}">Borrar</button></div>`;
  renderGallery(v.id);
  renderPinList(); // si los pines llegaron antes que la visita
}

// ---------- Galeria ----------

let gallery = { visitId: null, photos: [] };

async function renderGallery(visitId) {
  const box = $('#gallery');
  if (!box) return;
  try {
    gallery = { visitId, photos: (await api('photos', { query: { visit: visitId } })).photos };
  } catch (e) {
    box.innerHTML = `<p class="note">${esc(e.status === 503 ? 'Las fotos todavía no están configuradas.' : e.message)}</p>`;
    return;
  }
  if ($('#gallery') !== box || state.visit !== visitId) return; // ya se fue a otra visita
  paintGallery(box);
}

function paintGallery(box, uploading = []) {
  const n = gallery.photos.length;
  box.innerHTML =
    `<div class="visits-head"><h2>Fotos${n ? ` <span class="count">${n}</span>` : ''}</h2>` +
    `<label class="primary small add-photo">+ Agregar<input type="file" accept="image/*" multiple hidden data-add-photos></label></div>` +
    (n || uploading.length
      ? `<div class="grid">` +
        gallery.photos
          .map((p, i) => `<button class="tile" data-photo="${i}" aria-label="${esc(p.caption || `Foto ${i + 1}`)}"><img src="${esc(p.urls.thumb)}" alt="" loading="lazy" decoding="async"></button>`)
          .join('') +
        uploading.map((u) => `<div class="tile uploading ${u.state === 'error' ? 'err' : ''}" data-up="${u.i}"><span>${esc(UPLOAD_LABEL[u.state])}</span></div>`).join('') +
        `</div>`
      : `<p class="note">Agrega las fotos de esta visita. Se achican en tu teléfono antes de subir, y la fecha y el lugar donde se tomaron quedan guardados aparte, solo para ti.</p>`);
}

const UPLOAD_LABEL = { esperando: 'En espera', preparando: 'Preparando…', subiendo: 'Subiendo…', lista: 'Lista', error: 'Falló' };

document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-add-photos]');
  if (!input) return;
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  const box = $('#gallery');
  const visitId = gallery.visitId;
  const states = files.map((_, i) => ({ i, state: 'esperando' }));
  paintGallery(box, states);
  const { done, errors } = await uploadAll(visitId, files, (i, s) => {
    states[i].state = s;
    const tile = $(`#gallery [data-up="${i}"]`);
    if (tile) {
      tile.classList.toggle('err', s === 'error');
      tile.firstElementChild.textContent = UPLOAD_LABEL[s];
    }
  });
  if (errors.length) toast(errors.length === 1 ? errors[0] : `${errors.length} fotos no se subieron. ${errors[0]}`, 'err');
  else toast(done.length === 1 ? 'Foto agregada.' : `${done.length} fotos agregadas.`);
  if (gallery.visitId === visitId) renderGallery(visitId);
});

// Vista en grande: flechas, Escape, pie de foto y borrar.
function openPhoto(index) {
  const back = document.createElement('div');
  back.className = 'lightbox';
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', 'Foto');
  document.body.append(back);
  let i = index;
  const paint = () => {
    const p = gallery.photos[i];
    if (!p) return close();
    const when = p.takenAt ? new Date(p.takenAt).toLocaleString('es', { dateStyle: 'long', timeStyle: 'short' }) : '';
    back.innerHTML = `
      <button class="lb-close" data-lb="close" aria-label="Cerrar">✕</button>
      ${gallery.photos.length > 1 ? '<button class="lb-nav prev" data-lb="prev" aria-label="Anterior">‹</button><button class="lb-nav next" data-lb="next" aria-label="Siguiente">›</button>' : ''}
      <figure><img src="${esc(p.urls.full)}" alt="${esc(p.caption ?? '')}">
        <figcaption>
          <input class="lb-caption" value="${esc(p.caption ?? '')}" placeholder="Escribe un pie de foto…" maxlength="300" aria-label="Pie de foto">
          <span class="lb-meta">${esc(when)}${when ? ' · ' : ''}${i + 1} de ${gallery.photos.length}</span>
          ${p.lat != null ? '<button class="link light" data-lb="pin">📍 Marcar como lugar</button>' : ''}
          <button class="danger-link" data-lb="delete">Borrar foto</button>
        </figcaption>
      </figure>`;
  };
  const close = () => {
    removeEventListener('keydown', onKey);
    back.remove();
  };
  const move = (d) => {
    i = (i + d + gallery.photos.length) % gallery.photos.length;
    paint();
  };
  const onKey = (e) => {
    if (e.target.matches?.('.lb-caption')) {
      if (e.key === 'Enter') e.target.blur();
      return;
    }
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') move(-1);
    if (e.key === 'ArrowRight') move(1);
  };
  addEventListener('keydown', onKey);
  back.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (e.target === back || act === 'close') return close();
    if (act === 'prev') return move(-1);
    if (act === 'next') return move(1);
    if (act === 'pin') {
      // El GPS de la foto dice donde estabas: el lugar sale de ahi.
      const p = gallery.photos[i];
      close();
      const pin = await pinForm({ visitId: gallery.visitId, lat: p.lat, lng: p.lng, name: p.caption ?? '' });
      if (pin) {
        toast('Lugar agregado.');
        await loadPins();
        openPinPopup(pin.id, { fly: true });
      }
      return;
    }
    if (act === 'delete') {
      if (!(await ask({ title: '¿Borrar esta foto?', text: 'No se puede deshacer.', ok: 'Borrar', danger: true }))) return;
      try {
        await api('photos', { method: 'DELETE', query: { id: gallery.photos[i].id } });
        gallery.photos.splice(i, 1);
        if (!gallery.photos.length) close();
        else move(i >= gallery.photos.length ? -1 : 0);
        const box = $('#gallery');
        if (box) paintGallery(box);
        toast('Foto borrada.');
      } catch (ex) {
        toast(ex.message, 'err');
      }
    }
  });
  // El pie se guarda al salir del campo, sin boton: es lo que uno espera al escribir debajo de una foto.
  back.addEventListener('focusout', async (e) => {
    if (!e.target.matches('.lb-caption')) return;
    const p = gallery.photos[i];
    const caption = e.target.value.trim();
    if (caption === (p.caption ?? '')) return;
    try {
      p.caption = (await api('photos', { method: 'PUT', query: { id: p.id }, body: { caption } })).photo.caption;
    } catch (ex) {
      toast(ex.message, 'err');
    }
  });
  paint();
  back.querySelector('.lb-close').focus();
}

function renderEditor(panel, back, v) {
  const today = new Date().toISOString().slice(0, 10);
  panel.innerHTML =
    back +
    kindLine(v ? 'Editar visita' : `Nueva visita · ${nameOf(here())}`) +
    `<form class="editor" data-visit-form="${v?.id ?? ''}">
      <label class="field"><span>Título</span><input name="title" maxlength="120" required value="${esc(v?.title ?? '')}" placeholder="Semana Santa en las isletas" autofocus></label>
      <div class="field-row">
        <label class="field"><span>Desde</span><input name="startDay" type="date" max="${today}" value="${esc(v?.startDay ?? '')}"></label>
        <label class="field"><span>Hasta</span><input name="endDay" type="date" max="${today}" value="${esc(v?.endDay ?? '')}"></label>
      </div>
      <label class="field"><span>Lo que hiciste</span><textarea name="body" rows="9" maxlength="20000" placeholder="Llegamos el jueves temprano…">${esc(v?.body ?? '')}</textarea></label>
      <p class="form-error" hidden></p>
      <div class="actions start"><button class="primary">${v ? 'Guardar' : 'Crear visita'}</button>
      <button type="button" class="secondary" data-go="${esc(v ? `${v.placeId}/v/${v.id}` : here())}">Cancelar</button></div>
    </form>`;
  panel.querySelector('[autofocus]')?.focus();
}

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-visit-form]');
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.visitForm;
  const data = Object.fromEntries(new FormData(form));
  const err = form.querySelector('.form-error');
  err.hidden = true;
  await busy(form.querySelector('button.primary'), async () => {
    try {
      const r = id
        ? await api('visits', { method: 'PUT', query: { id }, body: data })
        : await api('visits', { method: 'POST', body: { ...data, placeId: here(), placeName: placeName() } });
      await visits.refresh();
      applyStates();
      toast(id ? 'Visita guardada.' : 'Visita creada.');
      go(`${r.visit.placeId}/v/${r.visit.id}`);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
});

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-go]');
  if (nav && !nav.hasAttribute('aria-current')) return go(nav.dataset.go || null);
  const photo = e.target.closest('[data-photo]');
  if (photo) return openPhoto(Number(photo.dataset.photo));
  const auth = e.target.closest('[data-auth]');
  if (auth) return account.openAuth(auth.dataset.auth);
  const login = e.target.closest('[data-login]');
  if (login) return account.openAuth('login', login.dataset.login);

  const t = e.target.closest('[data-toggle]');
  if (t) {
    await busy(t, async () => {
      try {
        await visits.setMark(t.dataset.toggle, !visits.isMarked(t.dataset.toggle));
        applyStates();
        renderPanel();
      } catch (ex) {
        toast(ex.message, 'err');
      }
    });
    return;
  }

  const del = e.target.closest('[data-delete]');
  if (del) {
    const ok = await ask({ title: '¿Borrar esta visita?', text: 'Se borra el relato completo. No se puede deshacer.', ok: 'Borrar', danger: true });
    if (!ok) return;
    try {
      await api('visits', { method: 'DELETE', query: { id: del.dataset.delete } });
      await visits.refresh();
      applyStates();
      toast('Visita borrada.');
      go(here());
    } catch (ex) {
      toast(ex.message, 'err');
    }
  }
});

// ---------- Cuenta ----------

const accountBtn = $('#account');
function renderAccountButton() {
  const me = account.current();
  accountBtn.textContent = me ? (me.fullName || me.name).trim().charAt(0).toUpperCase() : 'Entrar';
  accountBtn.classList.toggle('avatar', Boolean(me));
  accountBtn.setAttribute('aria-label', me ? `Tu cuenta (${me.name})` : 'Entrar o crear cuenta');
}
accountBtn.addEventListener('click', () => (account.current() ? account.openAccount() : account.openAuth('login')));
account.onChange(async (me) => {
  renderAccountButton();
  if (me) await visits.load().catch((e) => toast(e.message, 'err'));
  else visits.clear();
  applyStates();
  renderPanel();
  loadPins();
});
renderAccountButton();

// ---------- Estilo del mapa ----------

const picker = $('#basemap');
picker.innerHTML = BASEMAPS.map((b) => `<option value="${b.key}">${esc(b.label)}</option>`).join('');
picker.value = currentBasemap(true).key;
picker.addEventListener('change', () => {
  setBasemap(picker.value);
  map.setStyle(currentBasemap().url, { diff: false });
});
// En "Automático" el mapa sigue al tema del sistema.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentBasemap(true).key === 'auto') map.setStyle(currentBasemap().url, { diff: false });
});

// ---------- Busqueda ----------
// El indice (todos los departamentos y ciudades del mundo) pesa: se baja la
// primera vez que se escribe, no al abrir la app.

const q = $('#q');
const results = $('#results');
let entries = null;
let hits = [];
let active = -1;

async function loadEntries() {
  if (entries) return entries;
  const search = await geo.searchIndex();
  const rows = [world.features.map((f) => ({ id: f.properties.iso, name: f.properties.name, sub: 'País' }))];
  for (const [iso, list] of Object.entries(search)) {
    const nameById = new Map(list);
    const [l1, l2] = labels(iso);
    rows.push(
      list.map(([id, name]) => {
        const parts = id.split('.');
        const sub =
          parts.length === 2
            ? `${l1} · ${countryName.get(iso)}`
            : `${l2} · ${nameById.get(parts.slice(0, 2).join('.'))}, ${countryName.get(iso)}`;
        return { id, name, sub };
      }),
    );
  }
  entries = rows.flat().map((e) => ({ ...e, key: geo.fold(e.name) }));
  return entries;
}

async function runSearch() {
  const term = geo.fold(q.value.trim());
  if (!term) {
    hits = [];
  } else {
    const all = await loadEntries();
    if (geo.fold(q.value.trim()) !== term) return; // ya escribieron otra cosa
    hits = all
      .filter((e) => e.key.includes(term))
      .sort((a, b) => b.key.startsWith(term) - a.key.startsWith(term) || a.id.split('.').length - b.id.split('.').length || a.name.length - b.name.length)
      .slice(0, 8);
  }
  active = hits.length ? 0 : -1;
  paintResults();
}

function paintResults() {
  q.setAttribute('aria-expanded', String(hits.length > 0));
  results.innerHTML = hits
    .map((h, i) => `<li><button role="option" data-hit="${i}" aria-selected="${i === active}">${esc(h.name)}<small>${esc(h.sub)}</small></button></li>`)
    .join('');
}

function choose(i) {
  const h = hits[i];
  if (!h) return;
  q.value = '';
  hits = [];
  paintResults();
  q.blur();
  go(h.id);
}

q.addEventListener('focus', () => loadEntries());
q.addEventListener('input', runSearch);
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!hits.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    paintResults();
  } else if (e.key === 'Enter') {
    choose(active);
  } else if (e.key === 'Escape') {
    q.value = '';
    runSearch();
  }
});
results.addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-hit]');
  if (b) {
    e.preventDefault();
    choose(Number(b.dataset.hit));
  }
});
q.addEventListener('blur', () => setTimeout(() => { hits = []; paintResults(); }, 100));

// ---------- Arranque ----------

show(parseRoute(location.hash));
