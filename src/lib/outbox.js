// Things to send to the WakaWise server (problem reports, shared places, opt-in trip times).
// They wait on the phone while offline and are sent when there's a connection.

const KEY = 'outbox';
const MAX = 100;

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
};
const write = (list) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* storage full or blocked: drop it */
  }
};

/** Queue a POST to `path` (e.g. '/api/report') and try to send it now. */
export function send(path, body) {
  write([...read(), { path, body, at: Date.now() }]);
  flush();
}

let flushing = false;
export async function flush() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const item of read()) {
      let res;
      try {
        res = await fetch(item.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body) });
      } catch {
        break; // offline after all: try again later
      }
      if (res.status === 429 || res.status >= 500) break; // server busy: later
      // sent, or rejected for good (4xx): either way it leaves the queue
      write(read().filter((x) => x.at !== item.at || x.path !== item.path));
    }
  } finally {
    flushing = false;
  }
}

addEventListener('online', flush);
