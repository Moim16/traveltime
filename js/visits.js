// Lo visitado de quien entro. Vive en la base (api/marks.js); aqui queda una
// copia para pintar el mapa sin preguntar al servidor por cada poligono.
//
// Se guarda lo que uno marco (un municipio, o un pais sin divisiones) y los
// lugares con visitas. Que un departamento o un pais "esten visitados" se
// deduce por prefijo; no se guarda.

import { inside } from './geo.js';
import { api } from './api.js';

let marked = new Set();

export async function load() {
  marked = new Set((await api('marks')).marks);
}

export function clear() {
  marked = new Set();
}

export const isMarked = (id) => marked.has(id);
export const has = (area) => [...marked].some((id) => inside(id, area));

// Cuantas divisiones de cierta profundidad (1 departamento, 2 ciudad) dentro de
// un area tienen algo visitado. No necesita los poligonos: sale de los ids.
export function countUnder(area, depth) {
  const hit = new Set();
  for (const id of marked) {
    if (!inside(id, area)) continue;
    const parts = id.split('.');
    if (parts.length > depth) hit.add(parts.slice(0, depth + 1).join('.'));
  }
  return hit.size;
}

export async function setMark(placeId, on) {
  marked = new Set((await api('marks', { method: 'PUT', body: { placeId, on } })).marks);
}

// Crear o borrar una visita cambia lo visitado: el servidor lo recalcula.
export const refresh = load;
