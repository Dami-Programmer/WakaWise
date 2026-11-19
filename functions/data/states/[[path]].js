// Cloudflare Pages Function: serves the state packages from the R2 bucket bound as DATA, at the
// same paths the dev server uses (/data/states/index.json, /data/states/<slug>/<file>).
// Supports Range requests (resumable downloads, pmtiles reads) and If-Range, so a download that
// resumes after the data was rebuilt gets the whole new file instead of a mix of two versions.

const FILE = /^(index\.json|[a-z0-9-]+\/(tiles\.pmtiles|graph\.bin|graph\.json|search\.json))$/;
const TYPES = { json: 'application/json', pmtiles: 'application/vnd.pmtiles', bin: 'application/octet-stream' };

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const key = [].concat(params.path || []).join('/');
  if (!FILE.test(key)) return new Response('Not found', { status: 404 });

  const head = await env.DATA.head(key);
  if (!head) return new Response('Not found', { status: 404 });
  const size = head.size;

  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': TYPES[key.split('.').pop()] || 'application/octet-stream',
    ETag: head.httpEtag,
    // files are replaced in place when the data is rebuilt, so always revalidate
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length',
  });

  let range = parseRange(request.headers.get('Range'), size);
  const ifRange = request.headers.get('If-Range');
  if (range && ifRange && ifRange !== head.httpEtag) range = null; // file changed: send it all
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  if (!range) {
    headers.set('Content-Length', String(size));
    if (request.method === 'HEAD') return new Response(null, { headers });
    const obj = await env.DATA.get(key);
    return new Response(obj.body, { headers });
  }
  const { offset, length } = range;
  headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${size}`);
  headers.set('Content-Length', String(length));
  if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
  const obj = await env.DATA.get(key, { range: { offset, length } });
  return new Response(obj.body, { status: 206, headers });
}

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" -> {offset, length}; null if absent; 'invalid' if unsatisfiable. */
function parseRange(value, size) {
  if (!value) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!m || (!m[1] && !m[2])) return null; // multi-range or odd syntax: just send the whole file
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'invalid';
  return { offset: start, length: end - start + 1 };
}
