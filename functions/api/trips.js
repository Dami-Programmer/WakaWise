// POST /api/trips: opt-in travel times, to replace the guessed traffic ranges with real ones.
// Body: {slug, build, bucket, edges: [[edgeId, seconds], ...]}. Only totals per road piece and
// hour of the week are kept: no coordinates, no device or trip id.
import { json, isSlug, client, limited, body } from './_lib.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'not set up' }, 503);
  const b = await body(request, 40000);
  if (!b || !isSlug(b.slug) || typeof b.build !== 'string' || !/^[\w:.-]{1,40}$/.test(b.build)) return json({ error: 'bad request' }, 400);
  const bucket = b.bucket | 0;
  if (bucket < 0 || bucket > 47 || !Array.isArray(b.edges) || !b.edges.length || b.edges.length > 1500) return json({ error: 'bad request' }, 400);
  const who = await client(request, env);
  if (await limited(env, who, 30)) return json({ error: 'too many uploads, try later' }, 429);
  const rows = b.edges
    .filter((x) => Array.isArray(x) && Number.isInteger(x[0]) && x[0] >= 0 && x[0] < 1e8 && x[1] > 0 && x[1] < 3600)
    .map(([edge, s]) =>
      env.DB.prepare(
        'INSERT INTO edge_times (slug, build, edge, bucket, seconds, n) VALUES (?, ?, ?, ?, ?, 1) ' +
          'ON CONFLICT (slug, build, edge, bucket) DO UPDATE SET seconds = seconds + excluded.seconds, n = n + 1',
      ).bind(b.slug, b.build, edge, bucket, +(+s).toFixed(1)),
    );
  for (let i = 0; i < rows.length; i += 200) await env.DB.batch(rows.slice(i, i + 200));
  return json({ ok: true, saved: rows.length });
}
