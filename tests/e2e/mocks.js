// A fake of every outside host the page calls, so the browser tests need no network.
import { readFileSync } from 'node:fs';
import { cameraDistance } from '../../lib.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8'));
export const cameras = read('cameras.json').cameras;
const corridorOf = new Map(read('corridors.geojson').features.map((f) => [f.properties.oid, f.geometry]));

/** The count the page must show for a point, from the same saved data. */
export const expectedNear = (place, radius) =>
  cameras.filter((c) => cameraDistance(place.lat, place.lon, c, corridorOf.get(c.oid)) <= radius).length;

export const PLACES = {
  melrose: { text: '6300 Melrose Ave, Los Angeles, 90038', lat: 34.083420219893, lon: -118.335284951285, type: 'StreetAddress' },
  spring: { text: '200 North Spring Street, Los Angeles, 90012', lat: 34.054050703559, lon: -118.243184303049, type: 'PointAddress' },
  santaMonica: { text: '1685 Main St, Santa Monica, 90401', lat: 34.011657284227, lon: -118.492241991794, type: 'StreetAddress' },
  hobartN: { text: '1234 N Hobart Blvd, Los Angeles, 90029', lat: 34.094153624277, lon: -118.304577926538, type: 'StreetAddress' },
  hobartS: { text: '1234 S Hobart Blvd, Los Angeles, 90006', lat: 34.0482, lon: -118.3053, type: 'StreetAddress' },
  w23sp: { text: '1234 West 23Rd Street, San Pedro, 90731', lat: 33.7236, lon: -118.3043, type: 'PointAddress' },
  w23lb: { text: '1234 W 23rd St, Long Beach, 90810', lat: 33.7989, lon: -118.2077, type: 'StreetAddress' },
  w23la: { text: '1234 W 23rd St, Los Angeles, 90007', lat: 34.0349, lon: -118.2874, type: 'StreetAddress' },
  groves: { text: 'The Groves, Palmdale, 93551', lat: 34.5643, lon: -118.1672, type: 'StreetName' },
  groveDr: { text: 'The Grove Dr, Los Angeles, 90036', lat: 34.0722, lon: -118.3575, type: 'StreetName' },
  e99: { text: 'E 99th St, Inglewood, 90301', lat: 33.9467, lon: -118.3518, type: 'StreetName' },
};
export const SAN_FRANCISCO = { lat: 37.7749, lon: -122.4194 };

// What the fake county finder suggests while typing.
const SUGGEST = [
  [/^6300 mel/i, ['melrose']],
  [/^200 n/i, ['spring']],
  [/^1685 main/i, ['santaMonica']],
  [/^1234 hob/i, ['hobartN', 'hobartS']],
  [/^1234 w 23/i, ['w23lb', 'w23la', 'w23sp']],
  [/^the grove/i, ['groveDr']],
  [/^zzqq/i, ['e99']],
];
// What it answers for a full typed address: [place, score].
const CANDIDATES = [
  [/^6300 melrose ave/i, [['melrose', 100]]],
  [/^6300 melrose$/i, [['melrose', 97.5]]],
  [/^200 n spring st/i, [['spring', 100]]],
  [/^1685 main st, santa monica/i, [['santaMonica', 100]]],
  [/^1234 w 23rd st/i, [['w23sp', 100], ['w23lb', 100], ['w23la', 100]]],
  [/^the grove/i, [['groves', 100]]],
];
const PHOTON = [
  [/^dodger stadium/i, [{
    geometry: { coordinates: [-118.24, 34.0739] },
    properties: { name: 'Dodger Stadium', housenumber: '1000', street: 'Vin Scully Avenue', city: 'Los Angeles', state: 'California', postcode: '90012' },
  }]],
];

const lookup = (table, text) => table.find(([re]) => re.test(text.trim()))?.[1] ?? [];
const candidate = (id, score) => {
  const p = PLACES[id];
  return { address: p.text, score, location: { x: p.lon, y: p.lat }, attributes: { Addr_type: p.type } };
};

/** LADOT's live layer, built from the saved copy. `change` edits each feature's properties. */
export function liveFeatures(change = (p) => p) {
  return cameras.map((c) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    properties: change({ OBJECTID: c.oid, ID: `${c.district}-1`, System: c.status, StreetName: c.street, XStreet1: c.from, XStreet2: c.to }),
  }));
}

const MAP_STYLE = {
  version: 8, name: 'test', sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0ec' } }],
};

/**
 * Route every outside request. Options:
 *   ladot / county / photon / tiles: 'ok' or 'down'
 *   change: edits LADOT feature properties
 *   locateDelay: ms the county finder waits before it gives a position
 */
export async function mockNetwork(page, options = {}) {
  const o = { ladot: 'ok', county: 'ok', photon: 'ok', tiles: 'ok', change: undefined, locateDelay: 0, ...options };
  const calls = [];
  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
  });

  await page.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.href);
    const host = url.hostname;

    if (host.startsWith('fonts.')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });

    if (host === 'tiles.openfreemap.org') {
      return o.tiles === 'ok' && url.pathname === '/styles/positron' ? json(route, MAP_STYLE) : route.abort();
    }

    if (host === 'services.arcgis.com') {
      if (o.ladot !== 'ok') return route.abort();
      if (url.pathname.endsWith('/query')) return json(route, { type: 'FeatureCollection', features: liveFeatures(o.change) });
      return json(route, { editingInfo: { dataLastEditDate: Date.parse('2026-11-06T12:00:00Z') } });
    }

    if (host === 'geocode.gis.lacounty.gov') {
      if (o.county !== 'ok') return route.abort();
      if (url.pathname.endsWith('/suggest')) {
        const ids = lookup(SUGGEST, url.searchParams.get('text') ?? '');
        return json(route, { suggestions: ids.map((id) => ({ text: PLACES[id].text, magicKey: id, isCollection: false })) });
      }
      const key = url.searchParams.get('magicKey');
      if (key) {
        if (o.locateDelay) await new Promise((r) => setTimeout(r, o.locateDelay));
        return json(route, { candidates: PLACES[key] ? [candidate(key, 100)] : [] });
      }
      const hits = lookup(CANDIDATES, url.searchParams.get('SingleLine') ?? '');
      return json(route, { candidates: hits.map(([id, score]) => candidate(id, score)) });
    }

    if (host === 'photon.komoot.io') {
      if (o.photon !== 'ok') return route.abort();
      return json(route, { type: 'FeatureCollection', features: lookup(PHOTON, url.searchParams.get('q') ?? '') });
    }

    return route.abort(); // nothing else may leave the test
  });
  return calls;
}
