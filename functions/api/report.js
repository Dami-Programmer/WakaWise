// POST /api/report: "Report a problem" and places users chose to share.
// Body: {kind: 'problem'|'place', slug, lat, lon, topic, name, detail}
import { json, isSlug, text, inNigeria, client, limited, body } from './_lib.js';

const TOPICS = new Set(['closed', 'wrong-name', 'missing-road', 'wrong-place', 'not-here', 'other']);

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'not set up' }, 503);
  const b = await body(request, 4000);
  if (!b) return json({ error: 'bad request' }, 400);
  const kind = b.kind === 'place' ? 'place' : b.kind === 'problem' ? 'problem' : null;
  const lat = +b.lat, lon = +b.lon;
  if (!kind || !isSlug(b.slug) || !inNigeria(lat, lon)) return json({ error: 'bad request' }, 400);
  const topic = kind === 'problem' ? (TOPICS.has(b.topic) ? b.topic : 'other') : text(b.topic, 40);
  const name = text(b.name, 120);
  const detail = text(b.detail, 600);
  if (kind === 'place' && !name) return json({ error: 'name needed' }, 400);
  const who = await client(request, env);
  if (await limited(env, who, 30)) return json({ error: 'too many reports, try later' }, 429);
  await env.DB.prepare('INSERT INTO reports (at, kind, slug, lat, lon, topic, name, detail, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(Math.floor(Date.now() / 1000), kind, b.slug, +lat.toFixed(6), +lon.toFixed(6), topic, name, detail, who)
    .run();
  return json({ ok: true });
}
