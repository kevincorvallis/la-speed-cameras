// Unit tests for the route logic in lib.js. Run: node --test tests/unit
// The routes in tests/fixtures/routes.json are real answers from the route service,
// fetched by scripts/fetch_route_fixtures.mjs. Straight test lines alone would not catch
// a rule that fails on real street shapes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodePolyline, lineMiles, sampleLine, camerasOnRoute, routeFromValhalla, routeFromOsrm,
  sameRoute, formatMinutes, miles,
} from '../../lib.js';

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const cameras = read('data/cameras.json').cameras;
const corridorOf = new Map(read('data/corridors.geojson').features.map((f) => [f.properties.oid, f.geometry]));
const fixtures = read('tests/fixtures/routes.json');
const streetOf = (oid) => cameras.find((c) => c.oid === oid).street;

const run = (name) => {
  const route = routeFromValhalla(fixtures[name].trip);
  return { route, ...camerasOnRoute(route.coords, cameras, corridorOf) };
};
const oids = (list) => list.map((h) => h.oid);

describe('decodePolyline', () => {
  test('decodes the published example at 5 decimals', () => {
    assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  });
  test('an empty text gives no points', () => {
    assert.deepEqual(decodePolyline(''), []);
  });
  test('a real route starts and ends where it was asked to', () => {
    const { from, to, trip } = fixtures['fast:cityHall-santaMonica'];
    const coords = decodePolyline(trip.legs[0].shape);
    assert.ok(miles(from.lat, from.lon, coords[0][1], coords[0][0]) < 0.1);
    assert.ok(miles(to.lat, to.lon, coords.at(-1)[1], coords.at(-1)[0]) < 0.1);
  });
});

describe('lineMiles and sampleLine', () => {
  const line = [[-118.3, 34], [-118.3, 34.01], [-118.29, 34.01]];
  test('adds up the parts', () => {
    assert.ok(Math.abs(lineMiles(line) - (miles(34, -118.3, 34.01, -118.3) + miles(34.01, -118.3, 34.01, -118.29))) < 1e-9);
    assert.equal(lineMiles([]), 0);
  });
  test('the decoded line is as long as the route service says', () => {
    const { trip } = fixtures['streets:cityHall-santaMonica'];
    assert.ok(Math.abs(lineMiles(decodePolyline(trip.legs[0].shape)) - trip.summary.length) < 0.1);
  });
  test('samples keep the ends, stay close together and count miles upward', () => {
    const samples = sampleLine(line, 0.01);
    assert.deepEqual([samples[0].lon, samples[0].lat], line[0]);
    assert.deepEqual([samples.at(-1).lon, samples.at(-1).lat], line.at(-1));
    assert.ok(Math.abs(samples.at(-1).at - lineMiles(line)) < 1e-9);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i].at > samples[i - 1].at);
      assert.ok(samples[i].at - samples[i - 1].at <= 0.0101);
    }
  });
});

describe('camerasOnRoute: real routes', () => {
  test('a freeway drive counts no camera, and lists the camera street it passes over', () => {
    const { hits, crossed } = run('fast:cityHall-santaMonica');
    assert.deepEqual(oids(hits), []);
    assert.deepEqual(crossed.map((h) => streetOf(h.oid)), ['Arlington Ave']);
  });
  test('the same trip on surface streets counts the cameras on Olympic, in driving order', () => {
    const { hits, crossed } = run('streets:cityHall-santaMonica');
    assert.deepEqual(hits.map((h) => streetOf(h.oid)), [
      'Beverly Blvd', 'W Olympic Blvd', 'W Olympic Blvd', 'W Olympic Blvd', 'W Olympic Blvd', 'W Olympic Blvd',
    ]);
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i].at > hits[i - 1].at);
    assert.deepEqual(crossed.map((h) => streetOf(h.oid)), ['S La Cienega Blvd']);
  });
  for (const oid of [71, 114, 83, 5, 93]) {
    test(`a drive along stretch ${oid} (${streetOf(oid)}) counts its camera`, () => {
      const { hits } = run(`along:${oid}`);
      assert.ok(oids(hits).includes(oid));
    });
  }
  test('the narrowest stretch (18 m wide) counts for nearly its whole length', () => {
    const hit = run('along:71').hits.find((h) => h.oid === 71);
    assert.ok(hit.miles > 0.7, `${hit.miles} mi`);
  });
  test('the longest stretch counts for nearly its whole length', () => {
    const hit = run('along:93').hits.find((h) => h.oid === 93);
    assert.ok(hit.miles > 2.6, `${hit.miles} mi`);
  });
  for (const oid of [83, 5]) {
    test(`a drive straight across stretch ${oid} (${streetOf(oid)}) does not count its camera`, () => {
      const { hits, crossed } = run(`across:${oid}`);
      assert.ok(!oids(hits).includes(oid));
      assert.ok(oids(crossed).includes(oid));
    });
  }
  test('a short jog along a camera street counts: when unsure, the camera counts', () => {
    // This route turns onto W Washington Blvd for one short block between two cross streets.
    assert.ok(oids(run('across:114').hits).includes(114));
  });
  test('each hit carries the part of the route on the stretch', () => {
    for (const hit of run('streets:cityHall-santaMonica').hits) {
      assert.ok(hit.line.length >= 2);
      assert.ok(hit.miles >= 0.03);
    }
  });
});

describe('camerasOnRoute: rules', () => {
  // Venice Blvd, Pisani Pl to Lincoln Blvd: the widest stretch (81 m).
  const cam = cameras.find((c) => c.oid === 83);
  const only = [cam];
  test('no route points, no cameras', () => {
    assert.deepEqual(camerasOnRoute([], cameras, corridorOf), { hits: [], crossed: [] });
  });
  test('a route far away finds nothing', () => {
    const far = [[-117.9, 33.7], [-117.8, 33.7]];
    assert.deepEqual(camerasOnRoute(far, cameras, corridorOf), { hits: [], crossed: [] });
  });
  test('a route that ends on the camera street right at the stretch counts it', () => {
    const along = routeFromValhalla(fixtures['along:83'].trip).coords;
    const { hits } = camerasOnRoute(along.slice(0, Math.ceil(along.length / 2)), only, corridorOf);
    assert.deepEqual(oids(hits), [83]);
  });
  test('a reversed route counts the same cameras', () => {
    const coords = routeFromValhalla(fixtures['streets:cityHall-santaMonica'].trip).coords;
    const there = camerasOnRoute(coords, cameras, corridorOf);
    const back = camerasOnRoute([...coords].reverse(), cameras, corridorOf);
    assert.deepEqual(oids(back.hits).sort(), oids(there.hits).sort());
    assert.deepEqual(oids(back.hits), oids(there.hits).reverse());
  });
  test('a camera with no stretch on file counts when the route passes its point', () => {
    const coords = routeFromValhalla(fixtures['along:83'].trip).coords;
    const fresh = { ...cam, oid: 'new-1' };
    assert.deepEqual(oids(camerasOnRoute(coords, [fresh], new Map()).hits), ['new-1']);
    const away = { ...cam, oid: 'new-2', lat: cam.lat + 0.01 };
    assert.deepEqual(camerasOnRoute(coords, [away], new Map()).hits, []);
  });
});

describe('routeFromValhalla and routeFromOsrm', () => {
  test('reads miles, minutes and the two main streets', () => {
    const route = routeFromValhalla(fixtures['fast:cityHall-santaMonica'].trip);
    assert.ok(Math.abs(route.miles - 15.9) < 0.2);
    assert.ok(route.minutes >= 15 && route.minutes <= 30);
    assert.equal(route.via, 'I 10 West and CA 110 South');
  });
  test('a trip with no line is null', () => {
    assert.equal(routeFromValhalla(null), null);
    assert.equal(routeFromValhalla({ legs: [{}] }), null);
    assert.equal(routeFromValhalla({ legs: [{ shape: '' }] }), null);
  });
  test('reads an OSRM route', () => {
    const route = routeFromOsrm({
      distance: 16093.44, duration: 1260,
      geometry: { coordinates: [[-118.25, 34.05], [-118.3, 34.04]] },
      legs: [{ steps: [{ name: 'Harbor Freeway', distance: 4000 }, { name: '', distance: 9000 }, { name: 'Santa Monica Freeway', distance: 12000 }] }],
    });
    assert.ok(Math.abs(route.miles - 10) < 1e-6);
    assert.equal(route.minutes, 21);
    assert.equal(route.via, 'Santa Monica Freeway and Harbor Freeway');
    assert.equal(routeFromOsrm({ geometry: { coordinates: [] } }), null);
  });
});

describe('sameRoute', () => {
  const fast = routeFromValhalla(fixtures['fast:cityHall-santaMonica'].trip);
  const streets = routeFromValhalla(fixtures['streets:cityHall-santaMonica'].trip);
  test('a route is the same as itself', () => {
    assert.equal(sameRoute(fast, { ...fast }), true);
  });
  test('the freeway route and the street route differ', () => {
    assert.equal(sameRoute(fast, streets), false);
    assert.equal(sameRoute(streets, fast), false);
  });
});

describe('formatMinutes', () => {
  test('minutes, then hours and minutes', () => {
    assert.equal(formatMinutes(1), '1 min');
    assert.equal(formatMinutes(44), '44 min');
    assert.equal(formatMinutes(60), '1 hr');
    assert.equal(formatMinutes(65), '1 hr 5 min');
    assert.equal(formatMinutes(NaN), '');
  });
});
