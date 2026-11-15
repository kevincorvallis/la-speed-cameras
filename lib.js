// Pure logic for the LA speed camera map: no DOM, no network, no map.
// app.js imports it. The unit tests import it too.

export const RADII = [1, 2, 5]; // miles
export const STATUS_ORDER = ['fine', 'warn', 'other', 'build'];

/* ---------- Status ---------- */

// LADOT's three status values, in plain words. Each label repeats LADOT's listing.
// It does not promise what a camera does today: LADOT can be late to update.
const KNOWN_STATUS = {
  'under construction': {
    key: 'build', label: 'Under construction',
    note: 'LADOT lists it as under construction.',
    tally: (n) => `${n} ${n === 1 ? 'is' : 'are'} under construction`,
  },
  'warning live': {
    key: 'warn', label: 'Warning period',
    note: 'On. LADOT lists it in its 60-day warning period: it mails warnings, not fines.',
    tally: (n) => `${n} ${n === 1 ? 'is' : 'are'} in the warning period`,
  },
  'citation live': {
    key: 'fine', label: 'Issues tickets',
    note: 'On. LADOT lists it as issuing tickets.',
    tally: (n) => `${n} ${n === 1 ? 'issues' : 'issue'} tickets`,
  },
};

/** A value LADOT has not used before keeps LADOT's own text. */
export function statusOf(raw) {
  const text = String(raw ?? '').trim();
  const name = text.toLowerCase();
  if (Object.hasOwn(KNOWN_STATUS, name)) return KNOWN_STATUS[name];
  const label = text || 'Status not listed';
  return {
    key: /citation|enforc|fine|ticket/i.test(text) ? 'fine' : 'other',
    label,
    note: text ? `LADOT lists this camera as “${text}”.` : 'LADOT lists no status for this camera.',
    tally: (n) => `${n} ${n === 1 ? 'is' : 'are'} listed as “${label}”`,
  };
}

/** Cameras grouped by status label, in STATUS_ORDER. */
export function tally(cameras) {
  const groups = new Map();
  for (const cam of cameras) {
    const st = statusOf(cam.status);
    const g = groups.get(st.label) ?? { st, n: 0 };
    g.n += 1;
    groups.set(st.label, g);
  }
  return [...groups.values()].sort((a, b) =>
    STATUS_ORDER.indexOf(a.st.key) - STATUS_ORDER.indexOf(b.st.key));
}

/** Cameras LADOT lists as on. A status we do not know does not count as on. */
export function countOn(cameras) {
  return cameras.filter((c) => ['warn', 'fine'].includes(statusOf(c.status).key)).length;
}

/* ---------- Geometry ---------- */

const EARTH_MILES = 3958.8;
const MILES_PER_DEGREE = (EARTH_MILES * Math.PI) / 180;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in miles. */
export function miles(aLat, aLon, bLat, bLon) {
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return EARTH_MILES * 2 * Math.asin(Math.sqrt(h));
}

export function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const polygonsOf = (geom) => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates);

export function inGeometry(geom, lon, lat) {
  return polygonsOf(geom).some(([outer, ...holes]) =>
    inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
}

/** Council district number for a point, or null when the point is outside the city. */
export function districtAt(city, lon, lat) {
  for (const f of city.features) {
    if (inGeometry(f.geometry, lon, lat)) return f.properties.district;
  }
  return null;
}

/** Miles from a point to the nearest part of a polygon. 0 when the point is inside. */
export function milesToGeometry(geom, lat, lon) {
  if (inGeometry(geom, lon, lat)) return 0;
  const kx = Math.cos(rad(lat)) * MILES_PER_DEGREE;
  const ky = MILES_PER_DEGREE;
  let best = Infinity;
  for (const poly of polygonsOf(geom)) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const ax = (ring[i][0] - lon) * kx;
        const ay = (ring[i][1] - lat) * ky;
        const dx = (ring[i + 1][0] - lon) * kx - ax;
        const dy = (ring[i + 1][1] - lat) * ky - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return best;
}

/**
 * Miles from an address to a camera. A camera watches a stretch of street (its corridor),
 * and LADOT's point is only a label on that stretch. So the distance is to the nearest
 * part of the stretch, or to the point when it is nearer.
 */
export function cameraDistance(lat, lon, cam, corridor) {
  const toPoint = miles(lat, lon, cam.lat, cam.lon);
  return corridor ? Math.min(toPoint, milesToGeometry(corridor, lat, lon)) : toPoint;
}

export function circle(lat, lon, mi, steps = 96) {
  const ring = [];
  const dLat = mi / MILES_PER_DEGREE;
  const dLon = dLat / Math.cos(rad(lat));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

/**
 * "0.8 mi". Near a search radius it shows two decimals and rounds away from the radius,
 * so a camera just outside 2 miles never reads "2.0 mi".
 */
export function formatMiles(mi) {
  if (!Number.isFinite(mi)) return '';
  if (mi < 0.1) return `${Math.max(10, Math.round((mi * 5280) / 10) * 10)} ft`;
  if (mi >= 10) return `${Math.round(mi)} mi`;
  const edge = RADII.find((r) => mi !== r && Math.abs(mi - r) < 0.05);
  if (edge == null) return `${mi.toFixed(1)} mi`;
  const away = mi > edge ? Math.ceil(mi * 100) / 100 : Math.floor(mi * 100) / 100;
  return `${away.toFixed(2)} mi`;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- Address text ---------- */

/** Lower case, accents removed. */
export const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (text) => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

const ABBREVIATIONS = {
  north: 'n', south: 's', east: 'e', west: 'w',
  street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', road: 'rd', place: 'pl',
  lane: 'ln', court: 'ct', highway: 'hwy', parkway: 'pkwy', terrace: 'ter', circle: 'cir',
};
const short = (w) => ABBREVIATIONS[w] ?? w;
const DIRECTIONS = new Set(['n', 's', 'e', 'w']);
// Words that say little about which place is meant.
const FILLER = new Set(('n s e w st ave blvd dr rd pl ln ct way hwy and at the ca los angeles').split(' '));
const UNIT = /(?:#\s*|\b(?:apt|apartment|unit|suite|ste|spc|space)\b\.?\s*)[a-z0-9-]+/gi;
const FRACTION = /\b\d\/\d\b/g;

/** The typed address without a unit number or a "1/2": the address finders do not want them. */
export function cleanQuery(q) {
  return String(q ?? '').replace(UNIT, ' ').replace(FRACTION, ' ').replace(/\s+/g, ' ').trim();
}

/** One key for one place: "200 North Spring Street" and "200 N Spring St" in 90012 are the same. */
export function placeKey(place) {
  const zip = String(place.sub ?? '').match(/\b\d{5}\b/)?.[0] ?? fold(place.sub);
  return `${words(place.title).map(short).join(' ')}|${zip}`;
}

/** "6300 Melrose Ave, Los Angeles, 90038" -> title, sub and label. */
export function placeFromText(text, extra = {}) {
  const [title, ...rest] = String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!title) return null;
  const town = rest.find((s) => !/^\d{5}(-\d{4})?$/.test(s) && !/^(CA|USA)$/i.test(s));
  return { title, sub: rest.join(', '), label: town ? `${title}, ${town}` : title, ...extra };
}

export function placeFromPhoton(feature) {
  const p = feature?.properties ?? {};
  const lon = Number(feature?.geometry?.coordinates?.[0]);
  const lat = Number(feature?.geometry?.coordinates?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
  const title = p.name || street || p.city || p.county;
  if (!title) return null;
  const town = p.city || p.locality || p.district || p.county;
  const sub = [p.name && street !== p.name ? street : null, town, p.state, p.postcode]
    .filter((s) => s && s !== title);
  return {
    lat, lon, title: String(title),
    sub: sub.join(', '),
    label: town && town !== title ? `${title}, ${town}` : String(title),
  };
}

/** "5037032049, 3900 S FIGUEROA ST, LOS ANGELES CA, 90037" -> "3900 S Figueroa St, Los Angeles, 90037" */
export function tidyParcel(address) {
  return String(address ?? '')
    .replace(/^\d{6,},\s*/, '')
    .replace(/\s+CA(?=,|$)/, '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** One answer from the county finder's findAddressCandidates, as a place. */
export function placeFromCandidate(c) {
  const lat = Number(c?.location?.y);
  const lon = Number(c?.location?.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const type = String(c?.attributes?.Addr_type ?? '');
  const text = type === 'Parcel' ? tidyParcel(c.address) : c.address;
  return placeFromText(text, { lat, lon, type, score: Number(c.score) || 0 });
}

function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The one compass direction in a street name, or null when it has none or two. */
function directionOf(list) {
  const found = new Set(list.filter((w) => DIRECTIONS.has(w)));
  return found.size === 1 ? [...found][0] : null;
}

/**
 * True when the place fits what was typed: every real word of the query shows up in it.
 * Numbers must match in full ("123" is not "1234"). A long word may be one letter off.
 * "N" against "S" is never a fit. Keeps nonsense and near-misses out.
 */
export function looksLike(q, place) {
  const typed = words(cleanQuery(q)).map(short);
  const title = words(place.title).map(short);
  const hay = [...title, ...words(place.sub).map(short)];
  const typedDir = directionOf(typed);
  const titleDir = directionOf(title);
  if (typedDir && titleDir && typedDir !== titleDir) return false;
  let need = typed.filter((w) => !FILLER.has(w));
  if (!need.length) need = typed;
  if (!need.length) return false;
  return need.every((w) => hay.some((h) => {
    if (/^\d+$/.test(w)) return h === w;
    return h.startsWith(w) || (w.length >= 5 && oneEditApart(w, h));
  }));
}

function unique(places) {
  const seen = new Set();
  return places.filter((p) => {
    if (!p) return false;
    const key = placeKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Suggestions to show while typing: the ones that fit the query first. */
export function mergeSuggestions(q, county, photon = []) {
  const fits = (p) => p && looksLike(q, p);
  return unique([
    ...county.filter(fits), ...photon.filter(fits),
    ...county.filter((p) => !fits(p)), ...photon.filter((p) => !fits(p)),
  ]).slice(0, 7);
}

const PRECISE_TYPES = new Set(['PointAddress', 'StreetAddress', 'Subaddress', 'StreetInt', 'Parcel']);
const sameName = (a, b) => words(a).join(' ') === words(b).join(' ');

/**
 * Enter was pressed with nothing picked. Decide from the county finder's candidates.
 * Returns { pick } for one strong match, { choices } when several places tie, or null.
 * A street name alone ("Venice") is never strong: it does not say where on the street.
 */
export function decideOnEnter(q, candidates) {
  const strong = unique(candidates
    .filter((p) => p && p.score >= 90 && looksLike(q, p)
      && (PRECISE_TYPES.has(p.type) || (p.type === 'POI' && sameName(p.title, q))))
    .sort((a, b) => b.score - a.score || (a.type === 'Parcel') - (b.type === 'Parcel')));
  if (!strong.length) return null;
  const rivals = strong.filter((p) => p.score >= strong[0].score - 1.5);
  return rivals.length === 1 ? { pick: rivals[0] } : { choices: rivals };
}

/**
 * Enter with no strong county match. Decide from the suggestion list.
 * Returns { pick } when exactly one suggestion fits, else { choices, reason }.
 */
export function decideFromSuggestions(q, places) {
  const fits = places.filter((p) => looksLike(q, p));
  if (fits.length === 1) return { pick: fits[0] };
  if (fits.length > 1) return { choices: fits, reason: 'many' };
  return { choices: places, reason: places.length ? 'close' : 'none' };
}

/* ---------- LADOT live data ---------- */

export const streetKey = (street, from, to) => [street, from, to].map((s) => fold(s).trim()).join('|');

/**
 * Merge LADOT's live camera features into the saved cameras.
 * Throws when LADOT's fields changed, so the caller keeps the saved copy.
 */
export function mergeLive(saved, features, districtOf = () => null) {
  if (!Array.isArray(features) || features.length < 50) throw new Error('LADOT sent too few cameras');
  const byKey = new Map(saved.map((c) => [streetKey(c.street, c.from, c.to), c]));
  const left = new Set(saved);
  const cameras = [];
  let matched = 0;
  for (const f of features) {
    const p = f?.properties ?? {};
    const lon = Number(f?.geometry?.coordinates?.[0]);
    const lat = Number(f?.geometry?.coordinates?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (typeof p.System !== 'string' || typeof p.StreetName !== 'string') continue;
    let old = byKey.get(streetKey(p.StreetName, p.XStreet1, p.XStreet2));
    if (!old || !left.has(old)) {
      // The street text changed. A saved camera within 60 m is the same camera.
      old = [...left].find((c) => miles(lat, lon, c.lat, c.lon) < 0.04) ?? null;
    }
    if (old) { left.delete(old); matched += 1; }
    cameras.push({
      oid: old?.oid ?? `new-${p.OBJECTID}`,
      district: old?.district ?? districtOf(lon, lat),
      street: p.StreetName.trim(),
      from: String(p.XStreet1 ?? '').trim(),
      to: String(p.XStreet2 ?? '').trim(),
      lon, lat,
      status: p.System,
      limit: old?.limit ?? null,
      limitOther: old?.limitOther ?? null,
      school: old?.school ?? null,
    });
  }
  if (cameras.length < 50) throw new Error('LADOT sent too few usable cameras');
  if (matched < cameras.length * 0.8) throw new Error('LADOT no longer matches the saved copy');
  return cameras;
}

/** Changes when any camera's place or status changes. */
export const signature = (cameras) => JSON.stringify(cameras.map((c) => [c.oid, c.status, c.lat, c.lon]));

/* ---------- Layout ---------- */

/**
 * Decide which markers draw as speed limit signs. Signs never overlap: a marker whose
 * sign would cover one already placed stays a dot. `items` come in priority order.
 * Each item: { id, x, y, wants, selected }. Returns { signs, onScreen } as Sets of ids.
 */
export function layoutSigns(items, { width, height, signW = 36, signH = 42 }) {
  const placed = [];
  const signs = new Set();
  const onScreen = new Set();
  for (const it of items) {
    const visible = it.x >= 0 && it.x <= width && it.y >= 0 && it.y <= height;
    if (visible) onScreen.add(it.id);
    if (!it.selected && !(it.wants && visible)) continue;
    const scale = it.selected ? 1.4 : 1;
    const w = (signW * scale) / 2;
    const h = (signH * scale) / 2;
    const box = [it.x - w, it.y - h, it.x + w, it.y + h];
    const clash = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    if (clash && !it.selected) continue;
    placed.push(box);
    signs.add(it.id);
  }
  return { signs, onScreen };
}

/** Which sheet size a drag ends on. `velocity` is px per ms, up is positive. */
export function snapFor(height, velocity, snaps) {
  const target = height + velocity * 180; // carry the flick
  return Object.keys(snaps).reduce((best, name) =>
    (Math.abs(snaps[name] - target) < Math.abs(snaps[best] - target) ? name : best));
}
