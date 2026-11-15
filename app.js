import {
  Map as GLMap, Marker, LngLatBounds, AttributionControl, NavigationControl,
} from './vendor/maplibre-gl.mjs';
import {
  RADII, statusOf, tally, countOn, districtAt, cameraDistance, circle, formatMiles, plural,
  cleanQuery, placeFromText, placeFromPhoton, placeFromCandidate, looksLike, mergeSuggestions,
  decideOnEnter, decideFromSuggestions, mergeLive, signature, layoutSigns, snapFor,
} from './lib.js';

const LADOT_LAYER = 'https://services.arcgis.com/G3nmNsarwQblLhip/arcgis/rest/services/CameraSystems_streetnames2/FeatureServer/0';
const LADOT_PAGE = 'https://ladot.lacity.gov/speed-safety-system#locations';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
// Address search: LA County's own address finder first. It knows every county address.
// Photon (OpenStreetMap) adds places the county finder lacks, and answers when it is down.
const COUNTY_FINDER = 'https://geocode.gis.lacounty.gov/geocode/rest/services/CAMS_Locator/GeocodeServer';
const PHOTON = 'https://photon.komoot.io/api/';
const SEARCH_BOX = [-118.95, 33.6, -117.6, 34.85]; // Greater LA: west, south, east, north
const SIGN_ZOOM = 12.2; // dots turn into signs past this zoom
const FAR_MILES = 60; // past this, the address is not in the LA area at all
const SHEET_NAMES = ['peek', 'half', 'full'];
const SHEET_WORDS = { peek: 'small', half: 'medium', full: 'large' };

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Same query as the phone block in styles.css. A short, wide screen keeps the side panel.
const phone = matchMedia('(max-width: 719px) and (min-height: 480px)');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const el = {
  root: document.documentElement,
  dock: $('#dock'), search: $('#search'), input: $('#q'), clear: $('#clear'), locate: $('#locate'),
  suggest: $('#suggest'), panel: $('#panel'), grip: $('#grip'), body: $('#body'),
  view: $('#view'), foot: $('#foot'), status: $('#status'),
};

const state = {
  cameras: [],
  origin: null, // { lat, lon, label, kind, district }
  radius: 2,
  selected: null, // camera oid
  source: { live: false, editedAt: null, savedAt: null },
  sheet: 'peek',
  mapDown: false,
  allOpen: false, // the "All cameras" list on the overview
  listScroll: 0, // where the list was before a camera opened
  returnTo: 'list', // what opened the camera: 'list' or 'map'
};

let handMoved = false; // the person moved the map by hand since the last search

/** One short sentence for screen readers. The panel itself is not a live region. */
function announce(text) {
  el.status.textContent = '';
  requestAnimationFrame(() => { el.status.textContent = text; });
}

/* ---------- Data ---------- */

async function getJSON(url, ms = 9000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const [snapshot, corridors, city] = await Promise.all([
  getJSON('data/cameras.json'), getJSON('data/corridors.geojson'), getJSON('data/city.geojson'),
]).catch((err) => {
  el.view.innerHTML = '<h1>The camera data did not load</h1><p class="lede">Check the connection, then reload the page.</p>';
  throw err;
});
state.cameras = snapshot.cameras;
state.source.savedAt = snapshot.savedAt;
state.source.editedAt = snapshot.ladotEditedAt;

// The stretch of street each camera watches, by camera oid.
const corridorOf = new Map(corridors.features.map((f) => [f.properties.oid, f.geometry]));

/** Read the cameras LADOT publishes now. Returns true when anything changed. */
async function refreshFromLadot() {
  const metaCall = getJSON(`${LADOT_LAYER}?f=json`).catch(() => null); // only the date; may fail alone
  const live = await getJSON(`${LADOT_LAYER}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`);
  const next = mergeLive(state.cameras, live.features, (lon, lat) => districtAt(city, lon, lat));
  const changed = signature(next) !== signature(state.cameras);
  state.cameras = next;
  state.source.live = true;
  state.source.editedAt = (await metaCall)?.editingInfo?.dataLastEditDate ?? state.source.editedAt;
  return changed;
}

/* ---------- Map ---------- */

const cityBounds = new LngLatBounds();
for (const f of city.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) for (const pt of poly[0]) cityBounds.extend(pt);
}

const map = new GLMap({
  container: 'map',
  style: MAP_STYLE,
  bounds: cityBounds,
  fitBoundsOptions: { padding: mapPadding() },
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  maxBounds: [[-121.5, 32.2], [-115.0, 36.2]],
  minZoom: 7,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

const move = (opts) => (reduceMotion ? { ...opts, duration: 0 } : opts);

/** The part of the map that the search bar and the panel do not cover. */
function mapPadding() {
  if (phone.matches) {
    const top = el.search.getBoundingClientRect().bottom + 20;
    const sheet = snapHeights()[state.sheet === 'full' ? 'half' : state.sheet];
    return { top, bottom: sheet + 20, left: 30, right: 30 };
  }
  return { top: 48, bottom: 48, left: el.dock.getBoundingClientRect().right + 44, right: 64 };
}

function corridorData() {
  const byOid = new Map(state.cameras.map((c) => [c.oid, c]));
  return {
    type: 'FeatureCollection',
    features: corridors.features
      .filter((f) => byOid.has(f.properties.oid))
      .map((f) => ({ ...f, properties: { status: statusOf(byOid.get(f.properties.oid).status).key } })),
  };
}

// "style.load" comes as soon as the style file is in. "load" waits for the first tiles too.
// Our own layers go on at style.load, so the circle shows while street tiles still load.
let mapLoaded = false;
const mapReady = new Promise((resolve) => map.once('style.load', resolve));
map.once('load', () => {
  mapLoaded = true;
  if (state.mapDown) { state.mapDown = false; rerender(); }
  // The credit line opens by default. On a phone it starts closed, behind its button.
  if (phone.matches) {
    const credit = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    credit?.classList.remove('maplibregl-compact-show');
    credit?.removeAttribute('open');
  }
});

mapReady.then(() => {

  const layers = map.getStyle().layers;
  const firstRoad = layers.find((l) => l['source-layer'] === 'transportation')?.id;
  const firstLabel = layers.find((l) => l.type === 'symbol')?.id;
  const statusColor = ['match', ['get', 'status'], 'warn', '#f5b800', 'fine', '#d4281c', 'build', '#69717a', '#15181b'];

  // City limits: the land inside the city reads a shade lighter than its neighbors.
  map.addSource('city', { type: 'geojson', data: city });
  map.addLayer({ id: 'city-fill', type: 'fill', source: 'city', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.6, 'fill-antialias': false } }, firstRoad);
  map.addLayer({ id: 'city-line', type: 'line', source: 'city', paint: { 'line-color': '#15181b', 'line-opacity': 0.16, 'line-width': 1 } }, firstLabel);

  // The stretch of street each camera watches. The outline keeps a thin street visible from far away.
  map.addSource('corridors', { type: 'geojson', data: corridorData() });
  map.addLayer({
    id: 'corridors', type: 'fill', source: 'corridors',
    paint: { 'fill-color': statusColor, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.25, 12.5, 0.55] },
  }, firstLabel);
  map.addLayer({
    id: 'corridors-line', type: 'line', source: 'corridors',
    paint: {
      'line-color': statusColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 12, 2.5, 15, 1],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 12, 0.75, 15, 0.4],
    },
  }, firstLabel);

  map.addSource('radius', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#00664f', 'fill-opacity': 0.07 } }, firstLabel);
  map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#00664f', 'line-width': 1.6, 'line-dasharray': [3, 2.5] } }, firstLabel);

  drawRadius();
});

// A blocked or broken tile host would leave a silent blank map. Say so instead.
setTimeout(() => {
  if (!mapLoaded) { state.mapDown = true; rerender(); }
}, 10000);

const markers = new Map(); // oid -> { marker, node, btn }

/** The closest camera, when the search circle is empty. It still shows as a sign. */
function loneCamera() {
  if (!state.origin) return null;
  const closest = ranked()[0];
  return closest && closest.dist > state.radius ? closest : null;
}

const isNear = (cam, lone) => state.origin != null && (cam.dist <= state.radius || cam === lone);

function limitWords(cam) {
  if (cam.limit == null) return '';
  return cam.limitOther ? `${cam.limit} or ${cam.limitOther} mph limit. ` : `${cam.limit} mph limit. `;
}

function syncMarkers() {
  const live = new Set(state.cameras.map((c) => c.oid));
  for (const [oid, m] of markers) {
    if (!live.has(oid)) { m.marker.remove(); markers.delete(oid); }
  }
  const lone = loneCamera();
  for (const cam of state.cameras) {
    let m = markers.get(cam.oid);
    if (!m) {
      const node = document.createElement('div');
      node.className = 'cam';
      node.innerHTML = '<button type="button" class="cam__btn"><span class="cam__dot"></span><span class="sign"><b></b></span></button>';
      const btn = node.firstChild;
      const { oid } = cam;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        select(oid, { from: 'map' });
      });
      m = { node, btn, marker: new Marker({ element: node }).setLngLat([cam.lon, cam.lat]).addTo(map) };
      markers.set(cam.oid, m);
    }
    const st = statusOf(cam.status);
    m.marker.setLngLat([cam.lon, cam.lat]);
    m.node.dataset.status = st.key;
    m.btn.dataset.status = st.key;
    m.node.querySelector('b').textContent = cam.limit == null ? '' : Number(cam.limit);
    m.btn.setAttribute('aria-label', `Camera on ${cam.street}, ${cam.from} to ${cam.to}. ${limitWords(cam)}${st.label}.`);
    m.btn.setAttribute('aria-pressed', String(state.selected === cam.oid));
    m.node.classList.toggle('is-near', isNear(cam, lone));
    m.node.classList.toggle('is-selected', state.selected === cam.oid);
  }
  layoutMarkers();
}

/** Signs where they fit, dots elsewhere. Markers off the screen leave the tab order. */
function layoutMarkers() {
  const { width, height } = map.getContainer().getBoundingClientRect();
  const signsOn = map.getZoom() >= SIGN_ZOOM;
  const lone = loneCamera();
  const rank = (cam) => (state.selected === cam.oid ? 0 : isNear(cam, lone) ? 1 : 2);
  const items = [...state.cameras]
    .sort((a, b) => rank(a) - rank(b) || a.dist - b.dist || 0)
    .map((cam) => {
      const pt = map.project([cam.lon, cam.lat]);
      return { id: cam.oid, x: pt.x, y: pt.y, wants: signsOn || isNear(cam, lone), selected: state.selected === cam.oid };
    });
  const { signs, onScreen } = layoutSigns(items, { width, height });
  for (const [oid, m] of markers) {
    m.node.classList.toggle('is-sign', signs.has(oid));
    m.btn.tabIndex = onScreen.has(oid) ? 0 : -1;
  }
}

let layoutQueued = false;
map.on('move', () => {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layoutMarkers(); });
});

let originMarker = null;

function drawRadius() {
  const src = map.getSource('radius');
  if (!src) return;
  const o = state.origin;
  src.setData({ type: 'FeatureCollection', features: o ? [circle(o.lat, o.lon, state.radius)] : [] });
}

function drawOrigin() {
  originMarker?.remove();
  originMarker = null;
  if (state.origin) {
    const node = document.createElement('div');
    node.className = 'pin';
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', state.origin.label);
    originMarker = new Marker({ element: node }).setLngLat([state.origin.lon, state.origin.lat]).addTo(map);
  }
  drawRadius();
}

/** Fit the search circle, plus the closest camera when the circle is empty. */
function frameResults() {
  const o = state.origin;
  const closest = o ? ranked()[0] : null;
  if (!o || (closest && closest.dist > FAR_MILES)) {
    map.fitBounds(cityBounds, move({ padding: mapPadding(), duration: 900 }));
    return;
  }
  const ring = circle(o.lat, o.lon, state.radius, 24).geometry.coordinates[0];
  const box = ring.reduce((b, pt) => b.extend(pt), new LngLatBounds());
  if (closest && closest.dist > state.radius) box.extend([closest.lon, closest.lat]);
  map.fitBounds(box, move({ padding: mapPadding(), maxZoom: 15.5, duration: 1100 }));
}

/** Centre a camera in the part of the map the panel does not cover. */
function focusCamera(cam, { instant = false } = {}) {
  // An offset does this. A padding given to easeTo would stay on the map
  // and the next fitBounds would count it twice.
  const pad = mapPadding();
  map.easeTo(move({
    center: [cam.lon, cam.lat],
    zoom: Math.max(map.getZoom(), 14.6),
    offset: [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2],
    duration: instant ? 0 : 800,
  }));
}

/* ---------- State changes ---------- */

function ranked() {
  return [...state.cameras].sort((a, b) => a.dist - b.dist);
}

function measure() {
  const o = state.origin;
  for (const cam of state.cameras) {
    cam.dist = o ? cameraDistance(o.lat, o.lon, cam, corridorOf.get(cam.oid)) : Infinity;
  }
}

function focusHeading() {
  const h = el.view.querySelector('h1');
  if (!h) return;
  h.tabIndex = -1;
  h.focus({ preventScroll: true });
}

function summary() {
  const near = state.cameras.filter((c) => c.dist <= state.radius);
  const where = state.origin.kind === 'gps' ? 'your location' : state.origin.label;
  return `${plural(near.length, 'camera')} within ${plural(state.radius, 'mile')} of ${where}.`;
}

function setOrigin(origin) {
  state.origin = origin ? { ...origin, district: districtAt(city, origin.lon, origin.lat) } : null;
  state.selected = null;
  measure();
  drawOrigin();
  syncMarkers();
  render();
  setSheet(origin ? 'half' : 'peek');
  handMoved = false;
  frameResults();
  if (origin) {
    focusHeading();
    announce(summary());
  }
}

function setRadius(mi) {
  state.radius = mi;
  drawRadius();
  syncMarkers();
  render();
  frameResults();
  el.view.querySelector('.seg [aria-checked="true"]')?.focus();
  announce(summary());
}

function select(oid, { from = 'list' } = {}) {
  const was = state.selected;
  if (oid != null && was == null) {
    state.listScroll = el.body.scrollTop;
    state.returnTo = from;
  }
  state.selected = oid;
  syncMarkers();
  render();
  const cam = oid == null ? null : state.cameras.find((c) => c.oid === oid);
  if (cam) {
    if (phone.matches && state.sheet !== 'half') setSheet('half');
    focusCamera(cam);
    focusHeading();
    announce(`${cam.street}, ${cam.from} to ${cam.to}. ${statusOf(cam.status).label}.`);
    return;
  }
  // Back to the list: same scroll place, and focus returns to what opened the camera.
  el.body.scrollTop = state.listScroll;
  frameResults();
  const row = [...el.view.querySelectorAll('[data-oid]')].find((r) => r.dataset.oid === String(was));
  const marker = markers.get(was)?.btn;
  const back = state.returnTo === 'map' ? marker : row;
  if (back && back.offsetParent !== null) back.focus({ preventScroll: true });
  else focusHeading();
}

/* ---------- Panel ---------- */

function signHTML(cam, size) {
  const st = statusOf(cam.status);
  const words = size === 'big' ? '<span class="sign__words">SPEED<br>LIMIT</span>' : '';
  const figure = cam.limit == null ? '' : Number(cam.limit);
  return `<span class="sign sign--${size}" data-status="${st.key}" aria-hidden="true">${words}<b>${figure}</b></span>`;
}

function chipHTML(cam) {
  const st = statusOf(cam.status);
  return `<span class="chip" data-status="${st.key}">${esc(st.label)}</span>`;
}

function rowHTML(cam) {
  const st = statusOf(cam.status);
  const dist = Number.isFinite(cam.dist) ? `<span class="dist">${formatMiles(cam.dist)}</span>` : '';
  // The chip hides on a narrow panel, so screen readers get the status as text.
  return `<li><button type="button" class="row" data-oid="${esc(cam.oid)}">
    ${signHTML(cam, 'row')}
    <span class="row__main"><strong>${esc(cam.street)}</strong><span>${esc(cam.from)} to ${esc(cam.to)}</span><span class="sr">${esc(limitWords(cam))}${esc(st.label)}.</span></span>
    <span class="row__side">${dist}<span class="chip" data-status="${st.key}" aria-hidden="true">${esc(st.label)}</span></span>
  </button></li>`;
}

const mapNotice = () => (state.mapDown
  ? '<p class="notice">The street map did not load. The counts and the list still work.</p>'
  : '');

function overviewHTML() {
  const total = state.cameras.length;
  const on = countOn(state.cameras);
  const lede = on === 0
    ? `The city plans ${total} cameras. LADOT lists none as on yet.`
    : on === total
      ? `LADOT lists all ${total} city cameras as on.`
      : `The city plans ${total} cameras. LADOT lists ${on} as on now.`;
  const byStreet = [...state.cameras].sort((a, b) => a.street.localeCompare(b.street) || a.from.localeCompare(b.from));
  return `
    <h1>Speed cameras in Los Angeles</h1>
    <p class="lede">${lede} Enter an address to count the cameras near it.</p>
    ${mapNotice()}
    <ul class="legend">
      ${tally(state.cameras).map(({ st, n }) => `<li data-status="${st.key}">
        <span class="legend__dot"></span>
        <span><strong>${esc(st.label)}</strong><small>${esc(st.note)}</small></span>
        <span class="legend__n">${n}</span>
      </li>`).join('')}
    </ul>
    <details class="fold all" ${state.allOpen ? 'open' : ''}>
      <summary>All ${total} cameras, by street</summary>
      <ol class="cams">${byStreet.map(rowHTML).join('')}</ol>
    </details>`;
}

function resultsHTML() {
  const o = state.origin;
  const all = ranked();
  const near = all.filter((c) => c.dist <= state.radius);
  const rest = all.filter((c) => c.dist > state.radius).slice(0, 3);
  const span = plural(state.radius, 'mile');
  const where = o.kind === 'gps' ? 'of your location' : `of ${esc(o.label)}`;
  const place = o.kind === 'gps' ? 'location' : 'address';

  let mix = '';
  if (near.length) {
    mix = tally(near).map(({ st, n }) => `${esc(st.tally(n))}.`).join(' ');
    mix = mix.charAt(0).toUpperCase() + mix.slice(1);
  } else if (rest.length) {
    mix = `The closest camera is ${formatMiles(rest[0].dist)} away, on ${esc(rest[0].street)}.`;
  }

  let notice = '';
  if (all[0] && all[0].dist > FAR_MILES) {
    notice = `<p class="notice">This ${place} is about ${Math.round(all[0].dist)} miles from the nearest Los Angeles camera. The map shows only the city's cameras.</p>`;
  } else if (o.district == null) {
    notice = `<p class="notice">This ${place} is outside the City of Los Angeles. The map shows only the city's cameras.</p>`;
  }

  return `
    <h1 class="count">
      <span class="count__n">${near.length}</span>
      <span class="count__what">${near.length === 1 ? 'camera' : 'cameras'} within ${span} <small>${where}</small></span>
    </h1>
    <p class="mix">${mix}</p>
    ${notice}${mapNotice()}
    <div class="seg" role="radiogroup" aria-label="Distance from the ${place}">
      ${RADII.map((r) => `<button type="button" role="radio" aria-checked="${r === state.radius}" tabindex="${r === state.radius ? 0 : -1}" data-radius="${r}">${plural(r, 'mile')}</button>`).join('')}
    </div>
    ${near.length ? `<h2>Within ${span}</h2><ol class="cams">${near.map(rowHTML).join('')}</ol>` : ''}
    ${rest.length ? `<h2>${near.length ? 'Next closest' : 'Closest cameras'}</h2><ol class="cams">${rest.map(rowHTML).join('')}</ol>` : ''}`;
}

function detailHTML(cam) {
  const st = statusOf(cam.status);
  const limit = cam.limit == null ? null : Number(cam.limit);
  const other = cam.limitOther == null ? null : Number(cam.limitOther);
  const facts = [['Status', `${esc(st.label)}<small>${esc(st.note)}</small>`]];
  if (limit != null && other != null) {
    facts.push(['Speed limit', `${limit} or ${other} mph<small>LADOT's map and its district list give different limits.</small>`]);
    facts.push(['Tickets start at', `${limit + 11} or ${other + 11} mph<small>11 mph over the limit</small>`]);
  } else if (limit != null) {
    facts.push(['Tickets start at', `${limit + 11} mph<small>11 mph over the ${limit} mph limit</small>`]);
  }
  if (state.origin && Number.isFinite(cam.dist)) {
    facts.push([state.origin.kind === 'gps' ? 'From you' : 'From the address',
      `${formatMiles(cam.dist)}<small>To the nearest part of this stretch</small>`]);
  }
  if (cam.school != null) facts.push(['School nearby', cam.school ? 'Yes' : 'No']);
  if (cam.district != null) facts.push(['Council district', esc(cam.district)]);
  const lat = Number(cam.lat);
  const lon = Number(cam.lon);
  return `
    <button type="button" class="back" data-back>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6 6.5 6 6.5"/></svg>
      ${state.origin ? 'All results' : 'All cameras'}
    </button>
    <div class="detail">
      ${signHTML(cam, 'big')}
      <div>
        <h1>${esc(cam.street)}</h1>
        <p>${esc(cam.from)} to ${esc(cam.to)}</p>
        ${chipHTML(cam)}
      </div>
    </div>
    ${mapNotice()}
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener">Open in Google Maps</a>`;
}

/** Fines and source. Drawn apart from the view, so it keeps its open state and place. */
function renderFoot() {
  const { live, editedAt, savedAt } = state.source;
  const day = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const source = live
    ? `Camera data from <a href="${LADOT_PAGE}" target="_blank" rel="noopener">LADOT's map</a>${editedAt ? `, last changed ${day(editedAt)}` : ''}.`
    : `Camera data is a copy of <a href="${LADOT_PAGE}" target="_blank" rel="noopener">LADOT's map</a> saved ${day(savedAt)}. Status can be out of date.`;
  const open = el.foot.querySelector('.fines')?.open;
  el.foot.innerHTML = `
    <details class="fold fines" ${open ? 'open' : ''}>
      <summary>What a ticket costs</summary>
      <table>
        <tr><th scope="row">11 to 15 mph over the limit</th><td>$50</td></tr>
        <tr><th scope="row">16 to 25 mph over</th><td>$100</td></tr>
        <tr><th scope="row">26 mph or more over</th><td>$200</td></tr>
        <tr><th scope="row">100 mph or faster</th><td>$500</td></tr>
      </table>
      <p>The ticket goes by mail to the car's owner. It adds no point to a license. A car's first notice for 11 to 15 mph over is a warning.</p>
    </details>
    <p class="source">${source} A distance goes to the nearest part of the street a camera watches. This is not a city website. Address search by Los Angeles County and OpenStreetMap.</p>`;
}

function render() {
  const cam = state.selected != null && state.cameras.find((c) => c.oid === state.selected);
  el.view.innerHTML = cam ? detailHTML(cam) : state.origin ? resultsHTML() : overviewHTML();
  el.body.scrollTop = 0;
}

/** Redraw after a change the person did not make. Keeps the scroll place and the focus. */
function rerender() {
  const scroll = el.body.scrollTop;
  const hadFocus = el.view.contains(document.activeElement);
  render();
  el.body.scrollTop = scroll;
  if (hadFocus) focusHeading();
}

el.view.addEventListener('click', (e) => {
  const row = e.target.closest('[data-oid]');
  if (row) {
    const cam = state.cameras.find((c) => String(c.oid) === row.dataset.oid);
    if (cam) select(cam.oid, { from: 'list' });
    return;
  }
  const seg = e.target.closest('[data-radius]');
  if (seg) { setRadius(Number(seg.dataset.radius)); return; }
  if (e.target.closest('[data-back]')) select(null);
});

// Arrow keys move through the distance choices, from the one that has focus.
el.view.addEventListener('keydown', (e) => {
  const seg = e.target.closest?.('[data-radius]');
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!seg || !step) return;
  e.preventDefault();
  const i = RADII.indexOf(Number(seg.dataset.radius));
  setRadius(RADII[(i + step + RADII.length) % RADII.length]);
});

// "toggle" does not bubble. Capture it to remember the open list across renders.
el.view.addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('all')) state.allOpen = e.target.open;
}, true);

/* ---------- Bottom sheet (phone) ---------- */

function snapHeights() {
  const vh = window.innerHeight;
  const top = el.search.getBoundingClientRect().bottom;
  const full = Math.max(200, Math.round(vh - top - 10));
  return { peek: Math.min(176, full), half: Math.min(Math.round(vh * 0.5), full), full };
}

function setSheet(name) {
  state.sheet = name;
  el.root.style.setProperty('--sheet-h', `${snapHeights()[name]}px`);
  el.grip.setAttribute('aria-label', `Panel size: ${SHEET_WORDS[name]}. Press to change the size.`);
}

let drag = null;
el.grip.addEventListener('pointerdown', (e) => {
  if (!phone.matches) return;
  el.grip.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, y: e.clientY, h: el.panel.getBoundingClientRect().height, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
  el.panel.classList.add('is-dragging');
});
el.grip.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const h = Math.min(snapHeights().full, Math.max(96, drag.h + drag.y - e.clientY));
  if (Math.abs(e.clientY - drag.y) > 5) drag.moved = true;
  const dt = e.timeStamp - drag.lastT;
  if (dt > 0) drag.v = (drag.lastY - e.clientY) / dt; // px per ms, up is positive
  drag.lastY = e.clientY;
  drag.lastT = e.timeStamp;
  el.root.style.setProperty('--sheet-h', `${h}px`);
});
el.grip.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  el.panel.classList.remove('is-dragging');
  const { moved, v, lastT } = drag;
  drag = null;
  if (!moved) return; // a tap: the click handler below steps the size
  const flick = e.timeStamp - lastT > 80 ? 0 : v; // a finger that stopped carries no speed
  setSheet(snapFor(el.panel.getBoundingClientRect().height, flick, snapHeights()));
  el.grip.dataset.dragged = '1';
  setTimeout(() => { delete el.grip.dataset.dragged; }, 0); // only the click that ends this drag
});
el.grip.addEventListener('pointercancel', () => {
  if (!drag) return;
  el.panel.classList.remove('is-dragging');
  drag = null;
  setSheet(state.sheet); // the browser took the gesture: go back to the size before it
});
// A tap, a click, Enter or Space steps through the sizes.
el.grip.addEventListener('click', () => {
  if (el.grip.dataset.dragged || !phone.matches) return;
  setSheet(SHEET_NAMES[(SHEET_NAMES.indexOf(state.sheet) + 1) % SHEET_NAMES.length]);
});
el.grip.addEventListener('keydown', (e) => {
  const i = SHEET_NAMES.indexOf(state.sheet);
  if (e.key === 'ArrowUp' && i < 2) setSheet(SHEET_NAMES[i + 1]);
  if (e.key === 'ArrowDown' && i > 0) setSheet(SHEET_NAMES[i - 1]);
});

// Keep the view framed through window resizes and phone rotation,
// until the person moves the map by hand.
for (const type of ['dragstart', 'zoomstart']) {
  map.on(type, (e) => { if (e.originalEvent) handMoved = true; });
}
let resizeTimer = 0;
addEventListener('resize', () => {
  setSheet(state.sheet);
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    map.resize();
    const cam = state.selected != null && state.cameras.find((c) => c.oid === state.selected);
    const typing = document.activeElement === el.input; // a phone keyboard also resizes the window
    if (cam) focusCamera(cam, { instant: true });
    else if (!handMoved && !typing) frameResults();
  }, 150);
});

/* ---------- Address search ---------- */

const NOTES = {
  none: 'No address found in Los Angeles County. Check the street name, or add the city.',
  close: 'No exact match. Pick the closest one, or check the spelling.',
  many: 'More than one match. Pick one.',
  limited: 'Address search is limited right now. Results can be less exact.',
  down: 'Address search did not answer. Try again in a moment.',
  place: 'That address did not load. Try again in a moment.',
};

let places = [];
let active = -1;
let lookupTimer = 0;
let ticket = 0; // guards a new origin: a newer action wins over an older answer
let listTicket = 0; // guards the suggestion list: a closed list stays closed

// Show a busy sign when an answer takes more than a moment.
let pending = 0;
let busyTimer = 0;
function busy() {
  pending += 1;
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => el.search.classList.toggle('is-busy', pending > 0), 350);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pending -= 1;
    if (pending === 0) {
      clearTimeout(busyTimer);
      el.search.classList.remove('is-busy');
    }
  };
}

async function countySuggest(q) {
  const url = new URL(`${COUNTY_FINDER}/suggest`);
  url.search = new URLSearchParams({ f: 'json', text: cleanQuery(q), maxSuggestions: '6' });
  const data = await getJSON(url, 6000);
  if (!Array.isArray(data.suggestions)) throw new Error('County finder sent no list');
  return data.suggestions
    .map((s) => placeFromText(s?.text, { text: s?.text, magicKey: s?.magicKey }))
    .filter(Boolean);
}

async function photonSuggest(q) {
  const url = new URL(PHOTON);
  url.search = new URLSearchParams({
    q, limit: '6', lang: 'en', lat: '34.05', lon: '-118.25', bbox: SEARCH_BOX.join(','),
  });
  const data = await getJSON(url, 7000);
  return (data.features ?? []).map(placeFromPhoton).filter(Boolean);
}

/** Suggestions for the typed text. `limited` is true when the county finder is down. */
async function geocode(q) {
  let county = [];
  let limited = false;
  try { county = await countySuggest(q); } catch { limited = true; }
  let photon = [];
  if (!county.some((p) => looksLike(q, p))) {
    try { photon = await photonSuggest(q); } catch (err) { if (limited) throw err; }
  }
  return { places: mergeSuggestions(q, county, photon), limited };
}

/** The county finder's scored answers for a full typed address. */
async function countyCandidates(q) {
  const url = new URL(`${COUNTY_FINDER}/findAddressCandidates`);
  url.search = new URLSearchParams({
    f: 'json', SingleLine: cleanQuery(q), outSR: '4326', maxLocations: '6', outFields: 'Addr_type',
  });
  return ((await getJSON(url, 7000)).candidates ?? []).map(placeFromCandidate).filter(Boolean);
}

/** County suggestions carry no position. Ask the county finder where the address is. */
async function locate(place) {
  if (place.lat != null) return place;
  const url = new URL(`${COUNTY_FINDER}/findAddressCandidates`);
  url.search = new URLSearchParams({
    f: 'json', SingleLine: place.text, magicKey: place.magicKey ?? '', outSR: '4326', maxLocations: '1',
  });
  const hit = placeFromCandidate((await getJSON(url, 7000)).candidates?.[0]);
  if (!hit) throw new Error('No position for this address');
  return { ...place, lat: hit.lat, lon: hit.lon };
}

function closeSuggest() {
  el.suggest.hidden = true;
  el.suggest.innerHTML = '';
  el.input.setAttribute('aria-expanded', 'false');
  el.input.removeAttribute('aria-activedescendant');
  active = -1;
}

/** Close the list and drop any suggestion answer still on its way. */
function dismiss() {
  listTicket += 1;
  clearTimeout(lookupTimer);
  closeSuggest();
}

/** Show `list` under the search bar, with an optional note above it. */
function showPlaces(list, note = '') {
  places = list;
  active = -1;
  el.input.removeAttribute('aria-activedescendant');
  const rows = list.map((p, i) => `<li role="option" id="place-${i}" data-i="${i}" aria-selected="false">
    <strong>${esc(p.title)}</strong>${p.sub ? `<span>${esc(p.sub)}</span>` : ''}</li>`).join('');
  el.suggest.innerHTML = (note ? `<li class="suggest__note" role="presentation">${esc(note)}</li>` : '') + rows;
  el.suggest.hidden = false;
  el.input.setAttribute('aria-expanded', String(list.length > 0));
  const count = `${list.length} ${list.length === 1 ? 'address' : 'addresses'} found. Use the arrow keys to pick one.`;
  announce(note && list.length ? `${note} ${count}` : note || count);
}

function setActive(i) {
  active = i;
  for (const li of el.suggest.querySelectorAll('[role="option"]')) {
    const on = Number(li.dataset.i) === i;
    li.setAttribute('aria-selected', String(on));
    if (on) li.scrollIntoView({ block: 'nearest' });
  }
  if (i >= 0) el.input.setAttribute('aria-activedescendant', `place-${i}`);
  else el.input.removeAttribute('aria-activedescendant');
}

/** Type-ahead: fetch and show suggestions for the text typed so far. */
async function lookup(q) {
  const mine = ++listTicket;
  const done = busy();
  try {
    const found = await geocode(q);
    if (mine !== listTicket) return;
    showPlaces(found.places, found.places.length ? (found.limited ? NOTES.limited : '') : NOTES.none);
  } catch {
    if (mine === listTicket) showPlaces([], NOTES.down);
  } finally {
    done();
  }
}

/** Use this place as the address. */
async function choose(place) {
  el.input.value = place.label;
  el.clear.hidden = false;
  dismiss();
  el.input.blur();
  const mine = ++ticket;
  const done = busy();
  let found;
  try {
    found = await locate(place);
  } catch {
    if (mine === ticket) showPlaces([], NOTES.place);
    return;
  } finally {
    done();
  }
  if (mine !== ticket) return; // a newer action took over
  setOrigin({ lat: found.lat, lon: found.lon, label: place.label, kind: 'address' });
}

el.input.addEventListener('input', () => {
  // Any edit cancels an answer that is still on its way and drops the old list.
  ticket += 1;
  listTicket += 1;
  places = [];
  setActive(-1);
  el.clear.hidden = !el.input.value;
  clearTimeout(lookupTimer);
  const q = el.input.value.trim();
  if (q.length < 3) { closeSuggest(); return; }
  lookupTimer = setTimeout(() => lookup(q), 240);
});

el.input.addEventListener('focus', () => {
  if (phone.matches) setSheet('peek');
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Tab') { dismiss(); return; }
  if (el.suggest.hidden || !places.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % places.length); }
  if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active <= 0 ? places.length - 1 : active - 1); }
});

// Enter with nothing picked. Take one strong match. Else show the choices: never guess.
el.search.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el.input.value.trim();
  if (!q) return;
  if (active >= 0 && places[active]) { choose(places[active]); return; }
  clearTimeout(lookupTimer);
  listTicket += 1;
  if (q.length < 3 || !/[a-z0-9]/i.test(q)) { showPlaces([], NOTES.none); return; }
  const mine = ++ticket;
  const done = busy();
  try {
    const exact = decideOnEnter(q, await countyCandidates(q).catch(() => []));
    if (mine !== ticket) return;
    if (exact?.pick) { choose(exact.pick); return; }
    if (exact?.choices) { showPlaces(exact.choices, NOTES.many); return; }
    const found = await geocode(q);
    if (mine !== ticket) return;
    const next = decideFromSuggestions(q, found.places);
    if (next.pick) { choose(next.pick); return; }
    showPlaces(next.choices, next.reason === 'none' && found.limited ? NOTES.limited : NOTES[next.reason]);
  } catch {
    if (mine === ticket) showPlaces([], NOTES.down);
  } finally {
    done();
  }
});

// Choose on the click, so a press that slides off the option is cancelled.
// Do not cancel the pointerdown here: WebKit on a touch screen then drops the click.
el.suggest.addEventListener('click', (e) => {
  const li = e.target.closest('[role="option"]');
  if (li) choose(places[Number(li.dataset.i)]);
});

// The list closes on Escape, on Tab, and on a press outside the search bar.
// It does not close on blur: on a touch screen a tap can blur the field before its click lands.
document.addEventListener('pointerdown', (e) => {
  if (!el.search.contains(e.target)) dismiss();
});

el.clear.addEventListener('click', () => {
  ticket += 1;
  places = [];
  el.input.value = '';
  el.clear.hidden = true;
  dismiss();
  setOrigin(null);
  if (phone.matches) focusHeading();
  else el.input.focus();
  announce('Address cleared.');
});

el.locate.addEventListener('click', () => {
  dismiss();
  if (!navigator.geolocation) {
    showPlaces([], 'This browser does not share location. Type an address.');
    return;
  }
  const mine = ++ticket;
  const done = busy();
  el.locate.classList.add('is-busy');
  const finish = () => { done(); el.locate.classList.remove('is-busy'); };
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      finish();
      if (mine !== ticket) return; // an address was picked, typed or cleared while this waited
      el.input.value = 'Your location';
      el.clear.hidden = false;
      setOrigin({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your location', kind: 'gps' });
    },
    () => {
      finish();
      if (mine === ticket) showPlaces([], 'Location is off for this page. Type an address.');
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
});

/* ---------- Start ---------- */

if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__app = { map, state, setOrigin, geocode, countyCandidates, locate };
}

measure();
syncMarkers();
render();
renderFoot();
setSheet('peek');

refreshFromLadot()
  .then(async (changed) => {
    renderFoot(); // the source line now names the live data
    if (!changed) return;
    // Something changed at LADOT. Redraw, and keep the reader's place.
    measure();
    syncMarkers();
    rerender();
    await mapReady;
    map.getSource('corridors')?.setData(corridorData());
  })
  .catch((err) => console.warn('Using the saved camera copy:', err.message));
