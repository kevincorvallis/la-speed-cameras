import {
  RADII, statusOf, tally, countOn, districtAt, cameraDistance, circle, formatMiles, plural,
  cleanQuery, placeFromText, placeFromPhoton, placeFromCandidate, looksLike, mergeSuggestions,
  decideOnEnter, decideFromSuggestions, mergeLive, signature, layoutSigns, snapFor,
  camerasOnRoute, routeFromValhalla, routeFromOsrm, sameRoute, formatMinutes,
  formatParams, parseParams, bareURL,
} from './lib.js';

// Vercel's two scripts load after this file and send the page address with each report.
// Queue the hook that cuts the query string before they start: it can hold a searched address.
window.va = window.va || function va() { (window.vaq = window.vaq || []).push(arguments); };
window.si = window.si || function si() { (window.siq = window.siq || []).push(arguments); };
const cutQuery = (report) => ({ ...report, url: bareURL(report.url) });
window.va('beforeSend', cutQuery);
window.si('beforeSend', cutQuery);
/** Count one action in Vercel Web Analytics. Send kinds and counts only: no address, name or position. */
const track = (name, data) => window.va('event', { name, data });

const LADOT_LAYER = 'https://services.arcgis.com/G3nmNsarwQblLhip/arcgis/rest/services/CameraSystems_streetnames2/FeatureServer/0';
const LADOT_PAGE = 'https://ladot.lacity.gov/speed-safety-system#locations';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
// Address search: LA County's own address finder first. It knows every county address.
// Photon (OpenStreetMap) adds places the county finder lacks, and answers when it is down.
const COUNTY_FINDER = 'https://geocode.gis.lacounty.gov/geocode/rest/services/CAMS_Locator/GeocodeServer';
const PHOTON = 'https://photon.komoot.io/api/';
// Routes: Valhalla, on the German OpenStreetMap group's server. It can avoid freeways.
// That matters here: every camera stands on a city street. OSRM answers when Valhalla is down.
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving';
const SEARCH_BOX = [-118.95, 33.6, -117.6, 34.85]; // Greater LA: west, south, east, north
// How strong the camera stretches draw, by zoom. They fade while a route shows.
const CORRIDOR_FILL = ['interpolate', ['linear'], ['zoom'], 10, 0.25, 12.5, 0.55];
const CORRIDOR_LINE = ['interpolate', ['linear'], ['zoom'], 9, 0.5, 12, 0.75, 15, 0.4];
const SIGN_ZOOM = 12.2; // dots turn into signs past this zoom
const FAR_MILES = 60; // past this, the address is not in the LA area at all
const SHEET_NAMES = ['peek', 'half', 'full'];
const SHEET_WORDS = { peek: 'small', half: 'medium', full: 'large' };
// On a phone the sheet hides this sentence: the buttons under it say the same.
const OVERVIEW_HINT = '<span class="wide-only"> Enter an address to count the cameras near it, or map a drive to see the cameras on the way.</span>';

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
  near: $('#near'), trip: $('#trip'), from: $('#from'), to: $('#to'), openTrip: $('#open-trip'),
  closeTrip: $('#close-trip'), clearFrom: $('#clear-from'), clearTo: $('#clear-to'),
  swap: $('#swap'), locateFrom: $('#locate-from'),
};

/** A drive with nothing entered yet. Each route: { kind, coords, miles, minutes, via, hits, crossed }. */
const newTrip = () => ({ from: null, to: null, routes: [], pick: 0, phase: 'idle', partial: false });

const state = {
  cameras: [],
  mode: 'near', // 'near': the cameras near an address. 'trip': the cameras on a drive.
  trip: newTrip(), // phase: 'idle', 'loading', 'ready', 'failed' or 'none'
  origin: null, // { lat, lon, label, kind, district }
  radius: 2,
  selected: null, // camera oid
  source: { live: false, editedAt: null, savedAt: null },
  sheet: 'peek',
  mapDown: false,
  allOpen: false, // the "All cameras" list on the overview
  crossedOpen: false, // the "streets the route only crosses" list in a drive
  listScroll: 0, // where the list was before a camera opened
  returnTo: 'list', // what opened the camera: 'list' or 'map'
};

let readyForURL = false;
function syncURL() {
  if (!readyForURL) return;
  const next = `${location.pathname}${formatParams(state)}`;
  if (next !== `${location.pathname}${location.search}`) {
    history.replaceState(null, '', next);
  }
}

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
  el.view.removeAttribute('aria-busy');
  el.view.innerHTML = '<h1>The camera data did not load</h1><p class="lede">Check the connection, then try again.</p><a class="btn" href="">Try again</a>';
  throw err;
});
state.cameras = snapshot.cameras;
state.source.savedAt = snapshot.savedAt;
state.source.editedAt = snapshot.ladotEditedAt;

// The overview's opening line, in the panel now. render() draws the full view once the map code is in.
if (!location.search) {
  el.view.querySelector('.lede').innerHTML = `${esc(overviewLede())}${OVERVIEW_HINT}`;
}

// The map code is the largest file by far. index.html preloads it beside the camera data, so it is
// fetched and compiled by now, but running it holds the page for a while on a slow phone. Let the
// panel paint first: the counts are the first thing a person reads. (A tab in the background gets
// no frames, so a timer stands in.)
await new Promise((resolve) => { requestAnimationFrame(() => setTimeout(resolve, 0)); setTimeout(resolve, 120); });
const {
  Map: GLMap, Marker, LngLatBounds, AttributionControl, NavigationControl,
} = await import('./vendor/maplibre-gl.mjs');

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
  // A 3x phone screen draws 2.25 times the pixels of a 2x one, for no visible gain on a street map.
  pixelRatio: Math.min(devicePixelRatio || 1, 2),
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
// On a phone the credit sits bottom left. It opens and closes as the map loads, and there it moves nothing else.
map.addControl(new AttributionControl({ compact: true }), phone.matches ? 'bottom-left' : 'bottom-right');
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
    paint: { 'fill-color': statusColor, 'fill-opacity': CORRIDOR_FILL },
  }, firstLabel);
  map.addLayer({
    id: 'corridors-line', type: 'line', source: 'corridors',
    paint: {
      'line-color': statusColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 12, 2.5, 15, 1],
      'line-opacity': CORRIDOR_LINE,
    },
  }, firstLabel);

  map.addSource('radius', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#00664f', 'fill-opacity': 0.07 } }, firstLabel);
  map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#00664f', 'line-width': 1.6, 'line-dasharray': [3, 2.5] } }, firstLabel);

  // A drive. The route lies under the camera stretches. The parts of it that run along
  // a stretch lie over them, in the color of that camera's status.
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  for (const id of ['trip-alt', 'trip', 'trip-hits']) {
    map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  map.addLayer({ id: 'trip-alt-line', type: 'line', source: 'trip-alt', layout: round, paint: { 'line-color': '#7d868e', 'line-width': 5, 'line-opacity': 0.7 } }, 'corridors');
  map.addLayer({ id: 'trip-alt-hit', type: 'line', source: 'trip-alt', layout: round, paint: { 'line-width': 16, 'line-opacity': 0 } }, 'corridors');
  map.addLayer({ id: 'trip-case', type: 'line', source: 'trip', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 9 } }, 'corridors');
  map.addLayer({ id: 'trip-line', type: 'line', source: 'trip', layout: round, paint: { 'line-color': '#00664f', 'line-width': 5 } }, 'corridors');
  map.addLayer({ id: 'trip-hits-case', type: 'line', source: 'trip-hits', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 12 } }, firstLabel);
  map.addLayer({ id: 'trip-hits-line', type: 'line', source: 'trip-hits', layout: round, paint: { 'line-color': statusColor, 'line-width': 8 } }, firstLabel);
  // A press on the other route picks it, unless the point also sits on the active route.
  map.on('click', 'trip-alt-hit', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['trip-line'] }).length) return;
    const i = e.features?.[0]?.properties?.i;
    if (i != null) pickRoute(Number(i));
  });
  map.on('mousemove', 'trip-alt-hit', (e) => {
    const onActive = map.queryRenderedFeatures(e.point, { layers: ['trip-line'] }).length > 0;
    map.getCanvas().style.cursor = onActive ? '' : 'pointer';
  });
  map.on('mouseleave', 'trip-alt-hit', () => { map.getCanvas().style.cursor = ''; });

  drawRadius();
  drawTrip();
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

let tripOids = new Set(); // the cameras on the picked route

/** A camera to show as a sign: in the search circle, or on the drive. */
const isNear = (cam, lone) => (state.mode === 'trip'
  ? tripOids.has(cam.oid)
  : state.origin != null && (cam.dist <= state.radius || cam === lone));

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
function frameResults(opts) {
  if (state.mode === 'trip') { frameTrip(opts); return; }
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
  syncURL();
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
  syncURL();
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
  syncURL();
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

/** One camera in a list. `side` replaces the distance from the address. */
function rowHTML(cam, side = null) {
  const st = statusOf(cam.status);
  const dist = side ?? (Number.isFinite(cam.dist) ? `<span class="dist">${formatMiles(cam.dist)}</span>` : '');
  // The chip hides on a narrow panel, so screen readers get the status as text.
  return `<li><button type="button" class="row" data-oid="${esc(cam.oid)}">
    ${signHTML(cam, 'row')}
    <span class="row__main"><strong>${esc(cam.street)}</strong><span>${esc(cam.from)} to ${esc(cam.to)}</span><span class="sr">${esc(limitWords(cam))}${esc(st.label)}.</span></span>
    <span class="row__side">${dist}<span class="chip" data-status="${st.key}" aria-hidden="true">${esc(st.label)}</span></span>
  </button></li>`;
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5"/><path d="m7.5 8 4.5-4.5L16.5 8"/><path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"/></svg>';
/** A button that shares the page as it is now: the address, the drive or the camera are in the link. */
const shareHTML = (label = 'Share') => `<button type="button" class="btn btn--quiet" data-share>${SHARE_ICON}<span>${label}</span></button>`;

const mapNotice = () => (state.mapDown
  ? '<p class="notice">The street map did not load. The counts and the list still work.</p>'
  : '');

/** The overview's first sentence. Plain text: it also fills the panel before the map code loads. */
function overviewLede() {
  const total = state.cameras.length;
  const on = countOn(state.cameras);
  return on === 0
    ? `The city plans ${total} cameras. LADOT lists none as active yet.`
    : on === total
      ? `LADOT lists all ${total} city cameras as active.`
      : `The city plans ${total} cameras. LADOT lists ${on} as active.`;
}

function overviewHTML() {
  const total = state.cameras.length;
  const lede = overviewLede();
  const byStreet = [...state.cameras].sort((a, b) => a.street.localeCompare(b.street) || a.from.localeCompare(b.from));
  return `
    <h1>Speed cameras in Los Angeles</h1>
    <p class="lede">${lede}${OVERVIEW_HINT}</p>
    <div class="actions">
      <button type="button" class="btn" data-trip>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21v-8a4 4 0 0 1 4-4h9"/><path d="m15 4.5 4.5 4.5-4.5 4.5"/></svg>
        Map a drive
      </button>
      <button type="button" class="btn btn--quiet" data-locate><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" class="fill"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>Near me</button>
    </div>
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
      <ol class="cams">${byStreet.map((cam) => rowHTML(cam)).join('')}</ol>
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
    ${o.kind === 'address' ? `<div class="actions actions--tight">${shareHTML('Share these results')}</div>` : ''}
    ${notice}${mapNotice()}
    <div class="seg" role="radiogroup" aria-label="Distance from the ${place}">
      ${RADII.map((r) => `<button type="button" role="radio" aria-checked="${r === state.radius}" tabindex="${r === state.radius ? 0 : -1}" data-radius="${r}">${plural(r, 'mile')}</button>`).join('')}
    </div>
    ${near.length ? `<h2>Within ${span}</h2><ol class="cams">${near.map((cam) => rowHTML(cam)).join('')}</ol>` : ''}
    ${rest.length ? `<h2>${near.length ? 'Next closest' : 'Closest cameras'}</h2><ol class="cams">${rest.map((cam) => rowHTML(cam)).join('')}</ol>` : ''}`;
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
  if (state.mode === 'trip') {
    const route = state.trip.routes[state.trip.pick];
    const hit = route?.hits.find((h) => h.oid === cam.oid);
    if (hit) {
      const at = tripMiles(hit.at);
      facts.push(['On this drive', `${at.charAt(0).toUpperCase()}${at.slice(1)}<small>${hit.line.length
        ? `The route runs along this stretch for about ${formatMiles(hit.miles)}` : 'The route passes this camera'}</small>`]);
    } else if (route?.crossed.some((h) => h.oid === cam.oid)) {
      facts.push(['On this drive', 'Not counted<small>The route only crosses this street</small>']);
    } else if (route) {
      facts.push(['On this drive', 'Not on this route']);
    }
  }
  if (cam.school != null) facts.push(['School nearby', cam.school ? 'Yes' : 'No']);
  if (cam.district != null) facts.push(['Council district', esc(cam.district)]);
  const lat = Number(cam.lat);
  const lon = Number(cam.lon);
  return `
    <button type="button" class="back" data-back>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6 6.5 6 6.5"/></svg>
      ${state.mode === 'trip' ? 'Back to the drive' : state.origin ? 'All results' : 'All cameras'}
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
    <div class="actions">
      <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener" aria-label="Open in Google Maps">Google Maps</a>
      <a class="btn btn--quiet" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}" target="_blank" rel="noopener">Street View</a>
      ${shareHTML()}
    </div>`;
}

/** Fines, counting rules and source. Drawn apart from the view, so it keeps its open state and place. */
function renderFoot() {
  const { live, editedAt, savedAt } = state.source;
  const day = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const source = live
    ? `Camera data: <a href="${LADOT_PAGE}" target="_blank" rel="noopener">LADOT's map</a>${editedAt ? `, last changed ${day(editedAt)}` : ''}.`
    : `Camera data: a copy of <a href="${LADOT_PAGE}" target="_blank" rel="noopener">LADOT's map</a> saved ${day(savedAt)}. A status may be out of date.`;
  const isOpen = (name) => (el.foot.querySelector(`.${name}`)?.open ? 'open' : '');
  el.foot.innerHTML = `
    <details class="fold fines" ${isOpen('fines')}>
      <summary>What a ticket costs</summary>
      <table>
        <tr><th scope="row">11 to 15 mph over the limit</th><td>$50</td></tr>
        <tr><th scope="row">16 to 25 mph over</th><td>$100</td></tr>
        <tr><th scope="row">26 mph or more over</th><td>$200</td></tr>
        <tr><th scope="row">100 mph or faster</th><td>$500</td></tr>
      </table>
      <p>A ticket goes by mail to the car's registered owner. It adds no points to a license. A car's first violation at 11 to 15 mph over gets a warning.</p>
    </details>
    <details class="fold how" ${isOpen('how')}>
      <summary>How this map counts</summary>
      <ul>
        <li>A camera watches one stretch of a street. A distance goes to the nearest part of that stretch.</li>
        <li>A drive counts a camera when the route follows the camera's street. A street the route only crosses does not count.</li>
        <li>Drive times do not include traffic.</li>
        <li>The start and the end of a drive go to the route service, which finds the route.</li>
      </ul>
    </details>
    <p class="source">${source} Addresses: Los Angeles County and OpenStreetMap. Routes: Valhalla and OSRM, on OpenStreetMap data. This is not a city website.</p>`;
}

function render() {
  const cam = state.selected != null && state.cameras.find((c) => c.oid === state.selected);
  el.view.removeAttribute('aria-busy');
  el.view.innerHTML = cam ? detailHTML(cam)
    : state.mode === 'trip' ? tripHTML()
      : state.origin ? resultsHTML() : overviewHTML();
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

/** Share the link to this view: the phone's share sheet, or a copy of the link. */
async function shareView(button) {
  const url = location.href;
  const title = document.title;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title, url }); } catch { /* closed without sharing */ }
    return;
  }
  const label = button.querySelector('span');
  const before = label.textContent;
  try {
    await navigator.clipboard.writeText(url);
    label.textContent = 'Link copied';
    announce('Link copied.');
  } catch {
    label.textContent = 'Copy the address bar';
    announce('This browser blocked the copy. Copy the link from the address bar.');
  }
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => { if (button.isConnected) label.textContent = before; }, 2400);
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
  const route = e.target.closest('[data-route]');
  if (route) { pickRoute(Number(route.dataset.route)); return; }
  if (e.target.closest('[data-trip]')) { openTrip(); return; }
  if (e.target.closest('[data-locate]')) { useMyLocation(el.input, el.locate); return; }
  const share = e.target.closest('[data-share]');
  if (share) { shareView(share); return; }
  if (e.target.closest('[data-retry]')) { planTrip(); return; }
  if (e.target.closest('[data-back]')) select(null);
});

// Arrow keys move through the distance choices or the routes, from the one that has focus.
el.view.addEventListener('keydown', (e) => {
  const seg = e.target.closest?.('[data-radius]');
  const route = e.target.closest?.('[data-route]');
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step || (!seg && !route)) return;
  e.preventDefault();
  if (route) {
    const n = state.trip.routes.length;
    pickRoute((Number(route.dataset.route) + step + n) % n);
    return;
  }
  const i = RADII.indexOf(Number(seg.dataset.radius));
  setRadius(RADII[(i + step + RADII.length) % RADII.length]);
});

// "toggle" does not bubble. Capture it to remember open lists across renders.
el.view.addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('all')) state.allOpen = e.target.open;
  if (e.target.classList?.contains('crossed')) state.crossedOpen = e.target.open;
}, true);

/* ---------- Bottom sheet (phone) ---------- */

function snapHeights() {
  const vh = window.innerHeight;
  const top = el.search.getBoundingClientRect().bottom;
  const full = Math.max(200, Math.round(vh - top - 10));
  return { peek: Math.min(188, full), half: Math.min(Math.round(vh * 0.5), full), full };
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
    const typing = inputs.includes(document.activeElement); // a phone keyboard also resizes the window
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

// Three fields share one suggestion list: the address, and the two ends of a drive.
const inputs = [el.input, el.from, el.to];
let field = el.input; // the field the list belongs to
let places = [];
let active = -1;
let lookupTimer = 0;
// Guards a new place: a newer action on a field wins over an older answer for that field.
const tickets = new Map(inputs.map((input) => [input, 0]));
const bump = (input) => {
  tickets.set(input, tickets.get(input) + 1);
  return tickets.get(input);
};
const current = (input, mine) => tickets.get(input) === mine;
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
  for (const input of inputs) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
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
  field.removeAttribute('aria-activedescendant');
  const rows = list.map((p, i) => `<li role="option" id="place-${i}" data-i="${i}" aria-selected="false">
    <strong>${esc(p.title)}</strong>${p.sub ? `<span>${esc(p.sub)}</span>` : ''}</li>`).join('');
  el.suggest.innerHTML = (note ? `<li class="suggest__note" role="presentation">${esc(note)}</li>` : '') + rows;
  el.suggest.hidden = false;
  field.setAttribute('aria-expanded', String(list.length > 0));
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
  if (i >= 0) field.setAttribute('aria-activedescendant', `place-${i}`);
  else field.removeAttribute('aria-activedescendant');
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

/** A place is set for a field: the address, or one end of a drive. */
async function usePlace(input, spot) {
  if (input !== el.input) { setEnd(input === el.from ? 'from' : 'to', spot); return; }
  await setOrigin(spot);
  track('Address search', { kind: spot.kind, cameras: state.cameras.filter((c) => c.dist <= state.radius).length });
}

function syncTripClear() {
  el.clearFrom.hidden = !el.from.value;
  el.clearTo.hidden = !el.to.value;
}

/** Use this place for the field the list belongs to. */
async function choose(place) {
  const input = field;
  input.value = place.label;
  if (input === el.input) el.clear.hidden = false;
  else syncTripClear();
  dismiss();
  input.blur();
  const mine = bump(input);
  const done = busy();
  let found;
  try {
    found = await locate(place);
  } catch {
    if (current(input, mine)) { field = input; showPlaces([], NOTES.place); }
    return;
  } finally {
    done();
  }
  if (!current(input, mine)) return; // a newer action took over
  usePlace(input, { lat: found.lat, lon: found.lon, label: place.label, kind: 'address' });
}

for (const input of inputs) {
  input.addEventListener('input', () => {
    // Any edit cancels an answer that is still on its way and drops the old list.
    field = input;
    bump(input);
    listTicket += 1;
    places = [];
    setActive(-1);
    if (input === el.input) el.clear.hidden = !input.value;
    else syncTripClear();
    clearTimeout(lookupTimer);
    const q = input.value.trim();
    if (!q && input !== el.input) clearEnd(input === el.from ? 'from' : 'to');
    if (q.length < 3) { closeSuggest(); return; }
    lookupTimer = setTimeout(() => lookup(q), 240);
  });

  input.addEventListener('focus', () => {
    if (field !== input) dismiss(); // the open list belongs to another field
    field = input;
    if (phone.matches) setSheet('peek');
    if (input !== el.input && !phone.matches) input.select(); // typing replaces an end of the drive
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') { dismiss(); return; }
    // A form with more than one text field does not submit on Enter by itself.
    if (e.key === 'Enter') { e.preventDefault(); submitField(input); return; }
    if (el.suggest.hidden || !places.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % places.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active <= 0 ? places.length - 1 : active - 1); }
  });
}

/** Enter in a field. With nothing picked, take one strong match. Else show the choices: never guess. */
async function submitField(input) {
  field = input;
  const q = input.value.trim();
  if (!q) return;
  if (active >= 0 && places[active]) { choose(places[active]); return; }
  clearTimeout(lookupTimer);
  listTicket += 1;
  if (q.length < 3 || !/[a-z0-9]/i.test(q)) { showPlaces([], NOTES.none); return; }
  const mine = bump(input);
  const done = busy();
  try {
    const exact = decideOnEnter(q, await countyCandidates(q).catch(() => []));
    if (!current(input, mine)) return;
    field = input;
    if (exact?.pick) { choose(exact.pick); return; }
    if (exact?.choices) { showPlaces(exact.choices, NOTES.many); return; }
    const found = await geocode(q);
    if (!current(input, mine)) return;
    field = input;
    const next = decideFromSuggestions(q, found.places);
    if (next.pick) { choose(next.pick); return; }
    showPlaces(next.choices, next.reason === 'none' && found.limited ? NOTES.limited : NOTES[next.reason]);
  } catch {
    if (current(input, mine)) { field = input; showPlaces([], NOTES.down); }
  } finally {
    done();
  }
}

el.search.addEventListener('submit', (e) => {
  e.preventDefault();
  submitField(field);
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
  bump(el.input);
  places = [];
  el.input.value = '';
  el.clear.hidden = true;
  dismiss();
  setOrigin(null);
  if (phone.matches) focusHeading();
  else el.input.focus();
  announce('Address cleared.');
});

for (const [btn, input, which, msg] of [
  [el.clearFrom, el.from, 'from', 'Start cleared.'],
  [el.clearTo, el.to, 'to', 'End cleared.'],
]) {
  btn.addEventListener('click', () => {
    bump(input);
    places = [];
    input.value = '';
    syncTripClear();
    dismiss();
    clearEnd(which);
    input.focus();
    announce(msg);
  });
}

/** Fill a field with the device's position. */
function useMyLocation(input, button) {
  dismiss();
  field = input;
  if (!navigator.geolocation) {
    showPlaces([], 'This browser does not share location. Type an address.');
    return;
  }
  const mine = bump(input);
  const done = busy();
  button.classList.add('is-busy');
  const finish = () => { done(); button.classList.remove('is-busy'); };
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      finish();
      if (!current(input, mine)) return; // an address was picked, typed or cleared while this waited
      input.value = 'Your location';
      if (input === el.input) el.clear.hidden = false;
      else syncTripClear();
      usePlace(input, { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your location', kind: 'gps' });
    },
    () => {
      finish();
      if (current(input, mine)) { field = input; showPlaces([], 'Location is off for this page. Type an address.'); }
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
}

el.locate.addEventListener('click', () => useMyLocation(el.input, el.locate));
el.locateFrom.addEventListener('click', () => useMyLocation(el.from, el.locateFrom));

/* ---------- A drive ---------- */

const ROUTE_NAMES = { fast: 'Fastest route', streets: 'Avoids freeways' }; // the label on a route choice
const ROUTE_WORDS = { fast: 'fastest route', streets: 'route that avoids freeways' }; // the same, inside a sentence
const tripMiles = (at) => (at < 0.05 ? 'at the start' : `at ${at < 10 ? at.toFixed(1) : Math.round(at)} mi`);
const spotName = (spot) => (spot.kind === 'gps' ? 'your location' : spot.label);
/** A route with the cameras on it. */
const scored = (route) => ({ ...route, ...camerasOnRoute(route.coords, state.cameras, corridorOf) });

/** "15.9 mi, about 20 min without traffic. Via I 10 West and CA 110 South." */
function routeFacts(route) {
  const length = `${route.miles < 10 ? route.miles.toFixed(1) : Math.round(route.miles)} mi`;
  const time = route.minutes == null ? '' : `, about ${formatMinutes(route.minutes)} without traffic`;
  return `${length}${time}.${route.via ? ` Via ${esc(route.via)}.` : ''}`;
}

/** Ask Valhalla for one route. Null when it answers that no road goes there. */
async function valhallaRoute(from, to, auto) {
  const body = {
    locations: [from, to].map(({ lat, lon }) => ({ lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)) })),
    costing: 'auto', costing_options: { auto }, units: 'miles',
  };
  // A POST keeps the two places out of the web address. Plain text needs no extra CORS request.
  const res = await fetch(VALHALLA, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  const data = await res.json().catch(() => null);
  if (data?.trip) return routeFromValhalla(data.trip);
  if (res.status === 400 && data?.error_code) return null;
  throw new Error(`Route service: ${res.status}`);
}

async function osrmRoute(from, to) {
  const pair = [from, to].map(({ lat, lon }) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
  const data = await getJSON(`${OSRM}/${pair}?overview=full&geometries=geojson&steps=true`, 12000);
  return routeFromOsrm(data.routes?.[0]);
}

/**
 * The fastest route, and the route that avoids freeways when it differs.
 * A freeway passes no camera, so the fastest route alone could read "0 cameras"
 * for someone who drives the same trip on city streets.
 * `partial` is true when one of the two did not load. Throws when no service answers.
 */
async function fetchRoutes(from, to) {
  const [fast, streets] = await Promise.allSettled([
    valhallaRoute(from, to, {}), valhallaRoute(from, to, { use_highways: 0 }),
  ]);
  if (fast.status === 'rejected' && streets.status === 'rejected') {
    const route = await osrmRoute(from, to);
    return { routes: route ? [{ ...route, kind: 'fast' }] : [], partial: true };
  }
  const routes = [];
  if (fast.value) routes.push({ ...fast.value, kind: 'fast' });
  if (streets.value && !(routes[0] && sameRoute(routes[0], streets.value))) routes.push({ ...streets.value, kind: 'streets' });
  return { routes, partial: fast.status === 'rejected' || streets.status === 'rejected' };
}

const tripPins = [];
let hadRoute = false;

/** Draw the drive on the map: the two ends, the routes, and the parts on a camera stretch. */
function drawTrip() {
  for (const pin of tripPins.splice(0)) pin.remove();
  const t = state.trip;
  const picked = t.routes[t.pick];
  tripOids = new Set((picked?.hits ?? []).map((h) => h.oid));
  if (state.mode === 'trip') {
    for (const [end, letter, word] of [['from', 'A', 'Start'], ['to', 'B', 'End']]) {
      const spot = t[end];
      if (!spot) continue;
      const node = document.createElement('div');
      node.className = 'pin pin--end';
      node.dataset.end = end;
      node.textContent = letter;
      node.setAttribute('role', 'img');
      node.setAttribute('aria-label', `${word} of the drive: ${spot.label}`);
      tripPins.push(new Marker({ element: node }).setLngLat([spot.lon, spot.lat]).addTo(map));
    }
  }
  // While a route shows, the cameras off it fade, so the map agrees with the count.
  const hasRoute = Boolean(picked);
  el.root.classList.toggle('has-route', hasRoute);
  if (!map.getSource('trip')) return; // the map style is not in yet: it draws the drive when it is
  if (hasRoute !== hadRoute) {
    hadRoute = hasRoute;
    map.setPaintProperty('corridors', 'fill-opacity', hasRoute ? 0.12 : CORRIDOR_FILL);
    map.setPaintProperty('corridors-line', 'line-opacity', hasRoute ? 0.22 : CORRIDOR_LINE);
  }
  const all = (features) => ({ type: 'FeatureCollection', features });
  const line = (coordinates, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } });
  const byOid = new Map(state.cameras.map((c) => [c.oid, c]));
  map.getSource('trip').setData(all(picked ? [line(picked.coords)] : []));
  map.getSource('trip-alt').setData(all(t.routes.flatMap((r, i) => (i === t.pick ? [] : [line(r.coords, { i })]))));
  map.getSource('trip-hits').setData(all((picked?.hits ?? [])
    .filter((h) => h.line.length > 1 && byOid.has(h.oid))
    .map((h) => line(h.line, { status: statusOf(byOid.get(h.oid).status).key }))));
  map.triggerRepaint();
}

/** Fit the picked route, or the ends entered so far. */
function frameTrip({ quick = false } = {}) {
  const t = state.trip;
  const picked = t.routes[t.pick];
  const pts = picked ? picked.coords : [t.from, t.to].filter(Boolean).map((spot) => [spot.lon, spot.lat]);
  if (!pts.length) {
    map.fitBounds(cityBounds, move({ padding: mapPadding(), duration: 900 }));
    return;
  }
  const box = pts.reduce((b, pt) => b.extend(pt), new LngLatBounds());
  map.fitBounds(box, move({ padding: mapPadding(), maxZoom: 14.5, duration: quick ? 650 : 950 }));
}

function tripSummary() {
  const t = state.trip;
  if (t.phase === 'failed') return 'The route did not load.';
  if (t.phase === 'none') return 'No driving route found.';
  if (t.phase !== 'ready') return '';
  const route = t.routes[t.pick];
  return `${plural(route.hits.length, 'camera')} on this route.${t.routes.length > 1 ? ` ${ROUTE_NAMES[route.kind]}.` : ''}`;
}

function tripHTML() {
  const t = state.trip;
  const ends = t.from && t.to ? `${esc(spotName(t.from))} to ${esc(spotName(t.to))}` : '';
  if (t.phase === 'loading') {
    return `<h1>Finding the route</h1><p class="lede">From ${ends}.</p>${mapNotice()}
      <div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`;
  }
  if (t.phase === 'failed') {
    return `<h1>The route did not load</h1>
      <p class="lede">The route service did not answer. Check the connection, then try again.</p>
      <button type="button" class="btn" data-retry>Try again</button>`;
  }
  if (t.phase === 'none') {
    return `<h1>No driving route</h1><p class="lede">The route service found no way to drive from ${ends}.</p>${mapNotice()}`;
  }
  if (t.phase !== 'ready') {
    const next = t.from ? 'Now enter the end of the drive.'
      : t.to ? 'Now enter the start of the drive.'
        : 'Enter the start and the end of the drive.';
    return `<h1>Cameras on a drive</h1><p class="lede">${next} The map counts the cameras on the way.</p>${mapNotice()}`;
  }

  const route = t.routes[t.pick];
  const byOid = new Map(state.cameras.map((c) => [c.oid, c]));
  const hits = route.hits.filter((h) => byOid.has(h.oid));
  const crossed = route.crossed.filter((h) => byOid.has(h.oid));
  const n = hits.length;

  let mix;
  if (n) {
    mix = tally(hits.map((h) => byOid.get(h.oid))).map(({ st, n: k }) => `${esc(st.tally(k))}.`).join(' ');
    mix = mix.charAt(0).toUpperCase() + mix.slice(1);
  } else {
    mix = 'This route does not follow any street with a camera.';
    const other = t.routes.find((r) => r !== route && r.hits.length);
    if (other) mix = `The ${ROUTE_WORDS[other.kind]} passes ${plural(other.hits.length, 'camera')}.`;
  }

  let notice = '';
  if (t.partial && t.routes.length === 1) {
    notice = route.kind === 'fast'
      ? '<p class="notice">The route that avoids freeways did not load. A drive on city streets may pass more cameras.</p>'
      : '<p class="notice">The fastest route did not load. This is the route that avoids freeways.</p>';
  }

  const chooser = t.routes.length > 1
    ? `<div class="routes" role="radiogroup" aria-label="Route">${t.routes.map((r, i) => `
        <button type="button" role="radio" aria-checked="${i === t.pick}" tabindex="${i === t.pick ? 0 : -1}" data-route="${i}">
          <span class="routes__n" aria-hidden="true">${r.hits.length}<small>${r.hits.length === 1 ? 'camera' : 'cameras'}</small></span>
          <span><strong>${ROUTE_NAMES[r.kind]}</strong><span class="sr">${plural(r.hits.length, 'camera')}.</span><small>${routeFacts(r)}</small></span>
        </button>`).join('')}</div>`
    : `<p class="trip__sum">${routeFacts(route)}</p>`;

  const row = (h) => rowHTML(byOid.get(h.oid), `<span class="dist">${tripMiles(h.at)}</span>`);
  const those = crossed.length === 1 ? ['this street', 'it'] : ['these streets', 'them'];

  return `
    <h1 class="count">
      <span class="count__n">${n}</span>
      <span class="count__what">${n === 1 ? 'camera' : 'cameras'} on this route <small>${ends.charAt(0).toUpperCase()}${ends.slice(1)}</small></span>
    </h1>
    <p class="mix">${mix}</p>
    ${t.from?.kind === 'address' && t.to?.kind === 'address' ? `<div class="actions actions--tight">${shareHTML('Share this drive')}</div>` : ''}
    ${notice}${mapNotice()}
    ${chooser}
    ${n ? `<h2>On the way, in driving order</h2><ol class="cams">${hits.map(row).join('')}</ol>` : ''}
    ${crossed.length ? `<details class="fold crossed"${state.crossedOpen ? ' open' : ''}>
      <summary>${crossed.length === 1 ? '1 street with a camera' : `${crossed.length} streets with cameras`} that the route only crosses</summary>
      <p>A camera watches the traffic on its own street. The route only crosses ${those[0]}, or passes over ${those[1]} on a freeway, so ${crossed.length === 1 ? 'this camera is' : 'these cameras are'} not counted.</p>
      <ol class="cams">${crossed.map(row).join('')}</ol>
    </details>` : ''}`;
}

let tripTicket = 0; // guards the route: a swap, a new end or a closed drive drops an older answer

/** Find the routes for the two ends, count their cameras and show them. */
async function planTrip({ preferKind = null, keepSelected = null, report = true } = {}) {
  const t = state.trip;
  const mine = ++tripTicket;
  state.selected = null;
  state.crossedOpen = false;
  t.routes = [];
  t.pick = 0;
  t.partial = false;
  const show = () => {
    drawTrip();
    syncMarkers();
    render();
    handMoved = false;
    frameResults();
    syncURL();
  };
  if (!t.from || !t.to) {
    t.phase = 'idle';
    show();
    return;
  }
  t.phase = 'loading';
  show();
  const done = busy();
  let found = null;
  try { found = await fetchRoutes(t.from, t.to); } catch { /* no route service answered */ } finally { done(); }
  if (mine !== tripTicket) return;
  let routes = [];
  // A malformed route must not leave the panel on "Finding the route".
  try { routes = found ? found.routes.map(scored) : []; } catch { found = null; }
  if (!found) t.phase = 'failed';
  else if (!found.routes.length) t.phase = 'none';
  else {
    t.routes = routes;
    if (preferKind) {
      const idx = t.routes.findIndex((r) => r.kind === preferKind);
      if (idx >= 0) t.pick = idx;
    }
    t.partial = found.partial;
    t.phase = 'ready';
    if (keepSelected != null && state.cameras.some((c) => c.oid === keepSelected)) {
      state.selected = keepSelected;
    }
  }
  if (report) {
    track('Drive lookup', t.phase === 'ready'
      ? { result: 'ready', cameras: t.routes[t.pick].hits.length }
      : { result: t.phase });
  }
  setSheet('half');
  show();
  if (state.selected != null) {
    const cam = state.cameras.find((c) => c.oid === state.selected);
    if (cam) focusCamera(cam, { instant: true });
  }
  if (!inputs.includes(document.activeElement)) focusHeading();
  announce(tripSummary());
}

function setEnd(which, spot) {
  state.trip[which] = spot;
  planTrip();
  const other = which === 'from' ? 'to' : 'from';
  if (!state.trip[other] && !phone.matches) el[other].focus();
}

/** The field for one end was emptied: drop that end and its routes. */
function clearEnd(which) {
  if (!state.trip[which]) return;
  state.trip[which] = null;
  planTrip();
}

function pickRoute(i) {
  const t = state.trip;
  if (!t.routes[i] || i === t.pick) return;
  t.pick = i;
  state.selected = null;
  state.crossedOpen = false;
  drawTrip();
  syncMarkers();
  render();
  handMoved = false;
  frameResults({ quick: true });
  syncURL();
  // Keep the list at its top: a plain focus would scroll the count half out of view.
  el.view.querySelector('.routes [aria-checked="true"]')?.focus({ preventScroll: true });
  announce(tripSummary());
}

/** The cameras changed at LADOT: count the routes again. */
function rescoreTrip() {
  state.trip.routes = state.trip.routes.map(scored);
  drawTrip();
}

/** Switch the search bar between one address and the two ends of a drive. */
function showMode() {
  const trip = state.mode === 'trip';
  el.near.hidden = trip;
  el.trip.hidden = !trip;
  dismiss();
  setSheet(state.sheet); // the search bar changed height
}

function openTrip() {
  if (state.mode === 'trip') return;
  for (const input of inputs) bump(input);
  const start = state.origin ? { lat: state.origin.lat, lon: state.origin.lon, label: state.origin.label, kind: state.origin.kind } : null;
  state.mode = 'trip';
  state.crossedOpen = false;
  state.trip = { ...newTrip(), from: start };
  state.origin = null;
  el.from.value = start?.label ?? '';
  el.to.value = '';
  syncTripClear();
  measure();
  drawOrigin();
  showMode();
  planTrip();
  setSheet('peek');
  (start ? el.to : el.from).focus();
  announce(start ? 'Enter the end of the drive.' : 'Enter the start and the end of the drive.');
}

function closeTrip() {
  if (state.mode !== 'trip') return;
  for (const input of inputs) bump(input);
  tripTicket += 1;
  const back = state.trip.from;
  state.mode = 'near';
  state.crossedOpen = false;
  state.trip = newTrip();
  el.from.value = '';
  el.to.value = '';
  syncTripClear();
  el.input.value = back?.label ?? '';
  el.clear.hidden = !back;
  showMode();
  drawTrip();
  setOrigin(back); // with a start, this shows and announces the cameras near it
  if (!back) {
    el.openTrip.focus();
    announce('Drive closed.');
  }
}

el.openTrip.addEventListener('click', openTrip);
el.closeTrip.addEventListener('click', closeTrip);

el.swap.addEventListener('click', () => {
  const t = state.trip;
  const preferKind = t.routes[t.pick]?.kind ?? null;
  bump(el.from);
  bump(el.to);
  [t.from, t.to] = [t.to, t.from];
  [el.from.value, el.to.value] = [el.to.value, el.from.value];
  syncTripClear();
  dismiss();
  planTrip({ preferKind });
  announce('Start and end swapped.');
});

// "/" jumps to the search field, as on most map sites. Not while typing in a field.
addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
  (state.mode === 'trip' ? (el.from.value ? el.to : el.from) : el.input).focus();
});

/* ---------- Start ---------- */

if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__app = { map, state, setOrigin, geocode, countyCandidates, locate };
}

const initial = parseParams(location.search);
state.radius = initial.radius;
if (initial.mode === 'trip') {
  state.mode = 'trip';
  state.trip = { ...newTrip(), from: initial.from, to: initial.to };
  el.from.value = initial.from?.label ?? '';
  el.to.value = initial.to?.label ?? '';
  syncTripClear();
  measure();
  showMode();
  if (initial.from && initial.to) {
    planTrip({ preferKind: initial.routeKind, keepSelected: initial.selected, report: false });
  } else {
    drawTrip();
    syncMarkers();
    render();
    setSheet('peek');
    frameResults();
    if (initial.selected != null && state.cameras.some((c) => c.oid === initial.selected)) {
      select(initial.selected, { from: 'map' });
    }
  }
} else if (initial.origin) {
  el.input.value = initial.origin.label;
  el.clear.hidden = false;
  setOrigin(initial.origin);
  if (initial.selected != null && state.cameras.some((c) => c.oid === initial.selected)) {
    select(initial.selected, { from: 'map' });
  }
} else {
  measure();
  syncMarkers();
  render();
  setSheet('peek');
  if (initial.selected != null && state.cameras.some((c) => c.oid === initial.selected)) {
    select(initial.selected, { from: 'map' });
  }
}
renderFoot();
readyForURL = true;

refreshFromLadot()
  .then(async (changed) => {
    renderFoot(); // the source line now names the live data
    if (!changed) return;
    // Something changed at LADOT. Redraw, and keep the reader's place.
    measure();
    rescoreTrip();
    syncMarkers();
    rerender();
    await mapReady;
    map.getSource('corridors')?.setData(corridorData());
  })
  .catch((err) => console.warn('Using the saved camera copy:', err.message));
