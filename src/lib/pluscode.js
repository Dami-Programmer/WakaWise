// Open Location Code ("plus codes"): an open, offline way to name any spot, e.g. "6FR5JHG6+QR".
// Implements encode, decode and recovery of short codes ("JHG6+QR") near a reference point.
// Algorithm: https://github.com/google/open-location-code (Apache-2.0 spec).

const ALPHABET = '23456789CFGHJMPQRVWX';
const RES = [20, 1, 0.05, 0.0025, 0.000125]; // degrees per digit pair

export function encode(lat, lng) {
  lat = Math.min(90, Math.max(-90, lat));
  if (lat === 90) lat -= RES[4];
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  let latVal = Math.floor((lat + 90) * 8000);
  let lngVal = Math.floor((lng + 180) * 8000);
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = ALPHABET[latVal % 20] + ALPHABET[lngVal % 20] + code;
    latVal = Math.floor(latVal / 20);
    lngVal = Math.floor(lngVal / 20);
  }
  return `${code.slice(0, 8)}+${code.slice(8)}`;
}

/** Decode a full code; returns the centre {lat, lng} or null if invalid. */
export function decode(code) {
  const clean = code.toUpperCase().replace('+', '').replace(/0+$/, '');
  if (clean.length < 2 || clean.length > 10 || clean.length % 2) return null;
  let lat = -90;
  let lng = -180;
  let res = 20;
  for (let i = 0; i < clean.length; i += 2) {
    const a = ALPHABET.indexOf(clean[i]);
    const b = ALPHABET.indexOf(clean[i + 1]);
    if (a < 0 || b < 0) return null;
    res = RES[i / 2];
    lat += a * res;
    lng += b * res;
  }
  return { lat: lat + res / 2, lng: lng + res / 2 };
}

/** Full code from a short code (e.g. "JHG6+QR") using a nearby reference point. */
export function recoverNearest(short, refLat, refLng) {
  const code = short.toUpperCase();
  const sep = code.indexOf('+');
  if (sep >= 8) return code;
  const padding = 8 - sep;
  const resolution = 20 ** (2 - padding / 2);
  const half = resolution / 2;
  const full = decode(encode(refLat, refLng).replace('+', '').slice(0, padding) + code);
  if (!full) return null;
  let { lat, lng } = full;
  if (refLat + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (refLat - half > lat && lat + resolution <= 90) lat += resolution;
  if (refLng + half < lng) lng -= resolution;
  else if (refLng - half > lng) lng += resolution;
  return encode(lat, lng);
}

const FULL_RE = /^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{0,3}$/i;
const SHORT_RE = /^[23456789CFGHJMPQRVWX]{4,6}\+[23456789CFGHJMPQRVWX]{2,3}$/i;

/** Parse user text like "6FR5JHG6+QR" or "JHG6+QR Ikeja"; returns {lat, lng, code} or null. */
export function parsePlusCode(text, refLat, refLng) {
  const token = text.trim().split(/[\s,]+/)[0];
  if (FULL_RE.test(token)) {
    const p = decode(token);
    return p && { ...p, code: token.toUpperCase() };
  }
  if (SHORT_RE.test(token)) {
    const full = recoverNearest(token, refLat, refLng);
    const p = full && decode(full);
    return p && { ...p, code: full };
  }
  return null;
}
