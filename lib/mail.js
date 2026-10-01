// Mandar un correo: por ahora solo el codigo que confirma un registro nuevo.
//
// Resend por su API HTTP: en serverless una llamada fetch funciona bien; SMTP
// mantiene una conexion abierta, y en una funcion que muere al responder eso
// es fragil y lento.
//
// Sin RESEND_API_KEY no se envia nada y el registro sigue SIN confirmar el
// correo: si no, un despliegue sin la clave no tendria forma de crear la
// primera cuenta. Misma decision que en deudas.

const API = 'https://api.resend.com/emails';
const FROM = process.env.FROM_EMAIL || 'TravelTime <onboarding@resend.dev>';

export const mailReady = () => Boolean(process.env.RESEND_API_KEY);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const cleanEmail = (v) => (v ?? '').toString().trim().toLowerCase();
export const validEmail = (v) => EMAIL_RE.test(cleanEmail(v));

// Devuelve { ok } o { ok:false, error }. El texto va en HTML y en plano: hay
// clientes que no muestran HTML, y un correo con el codigo invisible no sirve.
export async function sendCode(email, code) {
  if (!mailReady()) return { ok: false, error: 'El correo no está configurado.' };
  const subject = `${code} es tu código de TravelTime`;
  const text = [
    `Tu código para crear la cuenta es: ${code}`,
    '',
    'Escríbelo en la app para terminar. Vence en 15 minutos.',
    '',
    'Si no fuiste tú, ignora este correo: sin el código no se crea nada.',
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#172033;">
      <p style="font-size:15px;line-height:1.5;margin:0 0 18px;">Tu código para crear la cuenta en <b>TravelTime</b>:</p>
      <div style="font-size:30px;font-weight:700;letter-spacing:6px;text-align:center;padding:18px;background:#fff5f5;border:1px solid #fbd0d2;border-radius:12px;color:#c81e3a;">${code}</div>
      <p style="font-size:13.5px;line-height:1.5;color:#5b6678;margin:18px 0 0;">Escríbelo en la app para terminar. Vence en 15 minutos.</p>
      <p style="font-size:13.5px;line-height:1.5;color:#5b6678;margin:10px 0 0;">Si no fuiste tú, ignora este correo: sin el código no se crea nada.</p>
    </div>`;
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [email], subject, text, html }),
    });
    if (r.ok) return { ok: true };
    // El detalle de Resend se registra, pero al usuario se le dice algo legible.
    console.error('resend fallo', r.status, (await r.text().catch(() => '')).slice(0, 300));
    return { ok: false, error: 'No se pudo enviar el correo. Revisa la dirección.' };
  } catch (err) {
    console.error('resend error', String(err));
    return { ok: false, error: 'No se pudo enviar el correo. Intenta de nuevo.' };
  }
}

// Seis digitos: se leen y se dictan sin equivocarse. La seguridad la ponen el
// tope de intentos y los 15 minutos de vida, no el largo.
export function newCode() {
  const b = crypto.getRandomValues(new Uint32Array(1));
  return String(b[0] % 1000000).padStart(6, '0');
}
