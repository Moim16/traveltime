// Hablar con /api. El token de la sesion vive en este navegador; todo lo demas
// (marcas, visitas) vive en la base y se pide cada vez.

const KEY = 'tt.token';

export function getToken() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {}
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// api('visits', { method: 'POST', query: { id }, body }) -> data, o lanza ApiError
// con el mensaje del servidor ya escrito para leerse.
export async function api(name, { method = 'GET', query, body } = {}) {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers['x-session-token'] = token;
  let res;
  try {
    res = await fetch(`/api/${name}${qs}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Sin conexión. Revisa tu internet e intenta de nuevo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // La sesion murio (cambio de contraseña en otro lado, recuperacion): se
    // olvida el token para no seguir mandando uno que no sirve.
    if (res.status === 401 && token && name !== 'auth') setToken(null);
    throw new ApiError(res.status, data.error || 'Algo falló. Intenta de nuevo.');
  }
  return data;
}
