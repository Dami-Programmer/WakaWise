// Places users add themselves ("Add a missing place"). Stored on this device for now;
// later they will also be sent to our server and fed into the next data refresh.

const KEY = (slug) => `userPlaces:${slug}`;

export function loadUserPlaces(slug) {
  try {
    return JSON.parse(localStorage.getItem(KEY(slug)) || '[]');
  } catch {
    return [];
  }
}

export function saveUserPlace(slug, place) {
  const list = loadUserPlaces(slug);
  const p = { ...place, id: `u${Date.now()}`, added: new Date().toISOString() };
  list.push(p);
  try {
    localStorage.setItem(KEY(slug), JSON.stringify(list));
  } catch {
    /* storage full or blocked: keep it for this session only */
  }
  return p;
}
