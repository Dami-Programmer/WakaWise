// Builds the search index and answers searches off the main thread, so the map stays smooth
// while a big state (Lagos: ~51k places) is being indexed on a slow phone.
import { Search } from './search.js';

let search = null;
self.onmessage = ({ data: m }) => {
  if (m.type === 'build') {
    search = new Search(JSON.parse(m.json));
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'add') {
    search?.addUserPlace(m.place);
  } else if (m.type === 'query') {
    // messages are handled in order, so a query sent during the build waits for it
    self.postMessage({ type: 'result', id: m.id, results: search ? search.query(m.q, m.center) : [] });
  }
};
