// El mapa de fondo: cual se usa y como se tine con los colores de la app.
// La interfaz sigue al mapa: con un fondo oscuro, el panel tambien es oscuro.

const TILES = 'https://tiles.openfreemap.org/styles';
export const BASEMAPS = [
  { key: 'auto', label: 'Automático' },
  { key: 'light', label: 'Claro', url: `${TILES}/positron`, theme: 'light', tint: true },
  { key: 'dark', label: 'Oscuro', url: `${TILES}/dark`, theme: 'dark', tint: true },
  { key: 'color', label: 'Colorido', url: `${TILES}/liberty`, theme: 'light', tint: false },
];

const KEY = 'tt.basemap';
const system = matchMedia('(prefers-color-scheme: dark)');

function stored() {
  try {
    return localStorage.getItem(KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

// raw: tal como lo eligio la persona ("auto" incluido). Sin raw: el mapa real.
export function currentBasemap(raw = false) {
  const key = stored();
  const chosen = BASEMAPS.find((b) => b.key === key) ?? BASEMAPS[0];
  if (raw || chosen.key !== 'auto') return chosen;
  return BASEMAPS.find((b) => b.key === (system.matches ? 'dark' : 'light'));
}

function applyTheme() {
  const b = currentBasemap(true);
  if (b.key === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = b.theme;
}

// Avisa con "tt:basemap": el mapa cambia de estilo y el selector se pone al dia
// (se puede cambiar desde el selector del mapa o desde "Tu perfil").
export function setBasemap(key) {
  try {
    localStorage.setItem(KEY, key);
  } catch {}
  applyTheme();
  dispatchEvent(new Event('tt:basemap'));
}

applyTheme();

// Positron y Dark son grises neutros: se les pone la tierra y el agua de la app
// para que el mapa se vea propio. Liberty ya trae sus colores y no se toca.
export function tintBasemap(map, css) {
  const b = currentBasemap();
  if (b.tint) {
    for (const l of map.getStyle().layers) {
      const src = l['source-layer'];
      if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', css('--map-land'));
      else if (l.type === 'fill' && src === 'water') map.setPaintProperty(l.id, 'fill-color', css('--map-water'));
      else if (l.type === 'line' && src === 'waterway') map.setPaintProperty(l.id, 'line-color', css('--map-water'));
    }
  }
  // Nombres en espanol: el estilo rotula en ingles ("Spain") y OpenStreetMap
  // trae name:es casi siempre.
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && l.layout?.['text-field']) {
      map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:es'], ['get', 'name:latin'], ['get', 'name']]);
    }
  }
  // La atmosfera del globo se desvanece al acercarse: en una ciudad estorba.
  map.setSky({
    'sky-color': css('--sky'),
    'horizon-color': css('--horizon'),
    'fog-color': css('--horizon'),
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.8,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  });
}
