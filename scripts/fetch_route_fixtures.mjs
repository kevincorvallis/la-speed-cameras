// Fetch real routes for the tests and save them in tests/fixtures/routes.json.
//   node scripts/fetch_route_fixtures.mjs
// Each fixture is a trimmed Valhalla trip. The tests and the fake router read them.
import { readFileSync, writeFileSync } from 'node:fs';

const ROUTER = 'https://valhalla1.openstreetmap.de/route';
const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const cameras = read('cameras.json').cameras;
const corridors = new Map(read('corridors.geojson').features.map((f) => [f.properties.oid, f.geometry]));

const KY = 69.09;
const KX = KY * Math.cos((34.05 * Math.PI) / 180);

/** The two ends and the middle of a corridor, plus a unit vector across it. */
function axis(oid) {
  const ring = corridors.get(oid).coordinates[0].map(([lon, lat]) => [lon * KX, lat * KY]);
  const n = ring.length;
  const mx = ring.reduce((s, p) => s + p[0], 0) / n;
  const my = ring.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0; let syy = 0; let sxy = 0;
  for (const [x, y] of ring) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const u = [Math.cos(a), Math.sin(a)];
  const t = ring.map(([x, y]) => (x - mx) * u[0] + (y - my) * u[1]);
  const lo = Math.min(...t) * 0.9;
  const hi = Math.max(...t) * 0.9;
  const at = (k, across = 0) => ({ lon: (mx + u[0] * k - u[1] * across) / KX, lat: (my + u[1] * k + u[0] * across) / KY });
  return { start: at(lo), end: at(hi), left: at(0, 0.16), right: at(0, -0.16) };
}

const PLACES = {
  cityHall: { lat: 34.054050703559, lon: -118.243184303049 },
  santaMonica: { lat: 34.011657284227, lon: -118.492241991794 },
  melrose: { lat: 34.083420219893, lon: -118.335284951285 },
};

const longest = [...corridors.keys()].reduce((best, oid) =>
  (corridors.get(oid).coordinates[0].length > corridors.get(best).coordinates[0].length ? oid : best));

const jobs = [
  ['fast:cityHall-santaMonica', PLACES.cityHall, PLACES.santaMonica, {}],
  ['streets:cityHall-santaMonica', PLACES.cityHall, PLACES.santaMonica, { use_highways: 0 }],
  ['fast:melrose-cityHall', PLACES.melrose, PLACES.cityHall, {}],
  ['streets:melrose-cityHall', PLACES.melrose, PLACES.cityHall, { use_highways: 0 }],
];
for (const oid of [71, 114, 83, 5, longest]) {
  const ax = axis(oid);
  jobs.push([`along:${oid}`, ax.start, ax.end, { use_highways: 0 }]);
  jobs.push([`across:${oid}`, ax.left, ax.right, { use_highways: 0 }]);
}

const out = {};
for (const [name, from, to, auto] of jobs) {
  const body = { locations: [from, to].map(({ lat, lon }) => ({ lat, lon })), costing: 'auto', costing_options: { auto }, units: 'miles' };
  const res = await fetch(`${ROUTER}?json=${encodeURIComponent(JSON.stringify(body))}`);
  const data = await res.json();
  const trip = data.trip;
  if (!trip?.legs?.[0]?.shape) { console.log('FAILED', name, data.error ?? res.status); continue; }
  out[name] = {
    from, to,
    trip: {
      summary: { length: trip.summary.length, time: trip.summary.time },
      legs: [{ shape: trip.legs[0].shape, maneuvers: trip.legs[0].maneuvers.map((m) => ({ street_names: m.street_names, length: m.length })) }],
    },
  };
  console.log('ok', name, trip.summary.length.toFixed(2), 'mi');
  await new Promise((r) => setTimeout(r, 1200)); // the public router asks for slow, spaced requests
}
writeFileSync(new URL('../tests/fixtures/routes.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log('longest corridor oid', longest, cameras.find((c) => c.oid === longest)?.street);
