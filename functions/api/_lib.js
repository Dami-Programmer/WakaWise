// Shared helpers for the /api functions (feedback stored in the D1 database bound as DB).

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const SLUG = /^[a-z0-9-]{2,40}$/;
export const isSlug = (s) => typeof s === 'string' && SLUG.test(s);
export const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const inNigeria = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat > 3.5 && lat < 14.5 && lon > 2 && lon < 15.5;

/** Hashed IP that changes every day: enough to stop floods, not enough to track anyone. */
export async function client(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${env.IP_SALT || 'wakawise'}|${day}|${ip}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** true if this client has sent more than `max` uploads in the last hour (and records this one). */
export async function limited(env, who, max) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM uploads WHERE client = ? AND at > ?').bind(who, now - 3600).first();
  if (row.c >= max) return true;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO uploads (client, at) VALUES (?, ?)').bind(who, now),
    env.DB.prepare('DELETE FROM uploads WHERE at < ?').bind(now - 86400),
  ]);
  return false;
}

export async function body(request, maxBytes) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  const raw = await request.text();
  if (raw.length > maxBytes) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
