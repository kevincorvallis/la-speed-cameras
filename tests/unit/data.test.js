// Checks on the saved copy in data/. Run: node --test tests/unit
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cameraDistance, districtAt, inGeometry, miles, statusOf } from '../../lib.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8'));
const { cameras, savedAt, ladotEditedAt } = read('cameras.json');
const corridors = read('corridors.geojson');
const city = read('city.geojson');
const corridorOf = new Map(corridors.features.map((f) => [f.properties.oid, f.geometry]));

const near = (lat, lon, radius) =>
  cameras.filter((c) => cameraDistance(lat, lon, c, corridorOf.get(c.oid)) <= radius);

describe('cameras.json', () => {
  test('has the cameras LADOT planned', () => {
    assert.ok(cameras.length >= 100 && cameras.length <= 200, `${cameras.length} cameras`);
  });
  test('every camera has the fields the app reads', () => {
    for (const c of cameras) {
      assert.equal(typeof c.street, 'string');
      assert.ok(c.street && c.from && c.to, `streets of ${c.oid}`);
      assert.equal(c.street, c.street.trim());
      assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), `position of ${c.oid}`);
      assert.equal(typeof c.status, 'string');
      assert.ok(c.school === true || c.school === false || c.school === null);
    }
  });
  test('ids are unique', () => {
    assert.equal(new Set(cameras.map((c) => c.oid)).size, cameras.length);
  });
  test('street names are unique: the app joins live data on them', () => {
    const keys = cameras.map((c) => `${c.street}|${c.from}|${c.to}`.toLowerCase());
    assert.equal(new Set(keys).size, cameras.length);
  });
  test('every camera stands in the Los Angeles area', () => {
    for (const c of cameras) {
      assert.ok(c.lat > 33.6 && c.lat < 34.4 && c.lon > -118.75 && c.lon < -118.1, `${c.street}: ${c.lat}, ${c.lon}`);
    }
  });
  test('every camera stands in or beside the city', () => {
    const outside = cameras.filter((c) => districtAt(city, c.lon, c.lat) == null);
    // A camera on a border street can fall a few metres outside the simplified outline.
    assert.ok(outside.length <= 6, `${outside.length} cameras outside the city outline: ${outside.map((c) => c.street)}`);
  });
  test('speed limits are real limits', () => {
    for (const c of cameras) {
      assert.ok([25, 30, 35, 40, 45, 50, 55].includes(c.limit), `${c.street}: limit ${c.limit}`);
      if (c.limitOther != null) {
        assert.ok([25, 30, 35, 40, 45, 50, 55].includes(c.limitOther));
        assert.notEqual(c.limitOther, c.limit);
      }
    }
  });
  test('council districts are 1 to 15', () => {
    for (const c of cameras) assert.ok(Number.isInteger(c.district) && c.district >= 1 && c.district <= 15);
    assert.equal(new Set(cameras.map((c) => c.district)).size, 15, 'every district has a camera');
  });
  test('every status is one the app names', () => {
    for (const c of cameras) assert.notEqual(statusOf(c.status).key, 'other', `unknown status "${c.status}"`);
  });
  test('has its dates', () => {
    assert.ok(!Number.isNaN(Date.parse(savedAt)));
    assert.ok(ladotEditedAt > Date.parse('2026-01-01'));
  });
});

describe('corridors.geojson', () => {
  test('one corridor for each camera', () => {
    assert.equal(corridors.features.length, cameras.length);
    for (const c of cameras) assert.ok(corridorOf.has(c.oid), `no corridor for ${c.street}`);
  });
  test('every corridor is a closed polygon', () => {
    for (const f of corridors.features) {
      assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
      const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
      for (const ring of rings) {
        assert.ok(ring.length >= 4);
        assert.deepEqual(ring[0], ring.at(-1));
      }
    }
  });
  test('every camera stands on or near its own corridor', () => {
    for (const c of cameras) {
      const d = cameraDistance(c.lat, c.lon, { lat: 0, lon: 0 }, corridorOf.get(c.oid));
      // LADOT's Victory Blvd point sits 323 m off its corridor. Nothing else is near that far.
      assert.ok(d < 0.25, `${c.street}: ${d.toFixed(3)} mi from its corridor`);
    }
  });
});

describe('city.geojson', () => {
  test('15 council districts', () => {
    assert.deepEqual(city.features.map((f) => f.properties.district).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
  });
  test('knows places inside and outside the city', () => {
    assert.equal(districtAt(city, -118.2428, 34.0537), 14, 'City Hall');
    assert.notEqual(districtAt(city, -118.3353, 34.0834), null, '6300 Melrose Ave');
    assert.equal(districtAt(city, -118.4922, 34.0117), null, 'Santa Monica');
    assert.equal(districtAt(city, -118.4003, 34.073), null, 'Beverly Hills');
    assert.equal(districtAt(city, -118.3707, 34.0903), null, 'West Hollywood');
    assert.equal(districtAt(city, -118.1959, 33.7677), null, 'Long Beach');
    assert.equal(districtAt(city, -118.2803, 33.7381), 15, 'San Pedro');
  });
  test('districts do not overlap at their centres', () => {
    for (const f of city.features) {
      const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      const [lon, lat] = ring[0];
      const hits = city.features.filter((g) => inGeometry(g.geometry, lon + 1e-7, lat + 1e-7)).length;
      assert.ok(hits <= 1);
    }
  });
});

describe('counts near known addresses', () => {
  // The count must be at least the plain point count: a stretch can only bring a camera nearer.
  const points = (lat, lon, r) => cameras.filter((c) => miles(lat, lon, c.lat, c.lon) <= r).length;
  const spots = [
    ['6300 Melrose Ave', 34.08342, -118.335285],
    ['City Hall', 34.054051, -118.243184],
    ['Santa Monica City Hall', 34.011657, -118.492242],
    ['Van Nuys', 34.1845, -118.4472],
    ['San Pedro', 33.7381, -118.2803],
  ];
  for (const [name, lat, lon] of spots) {
    test(`${name}: wider circles hold more cameras`, () => {
      const [a, b, c] = [1, 2, 5].map((r) => near(lat, lon, r).length);
      assert.ok(a <= b && b <= c);
      for (const r of [1, 2, 5]) assert.ok(near(lat, lon, r).length >= points(lat, lon, r));
    });
  }
  // Fixed numbers, checked on 2026-11-15 with separate code (winding-number inside test,
  // edges sampled every 5 m) on LADOT's full-resolution corridors. They change only when
  // LADOT moves, adds or removes a camera: then recount, and update them.
  const pinned = [
    ['1234 N Hobart Blvd', 34.094153624277, -118.304577926538, [4, 9, 33]],
    ['6300 Melrose Ave', 34.083420219893, -118.335284951285, [2, 11, 35]],
    ['200 N Spring St (City Hall)', 34.054050703559, -118.243184303049, [2, 7, 30]],
    ['1685 Main St, Santa Monica', 34.011657284227, -118.492241991794, [0, 0, 7]],
  ];
  for (const [name, lat, lon, want] of pinned) {
    test(`${name}: ${want.join(' / ')} cameras within 1 / 2 / 5 miles`, () => {
      assert.deepEqual([1, 2, 5].map((r) => near(lat, lon, r).length), want);
    });
  }
  test('Santa Monica City Hall has no camera within 2 miles', () => {
    assert.equal(near(34.011657, -118.492242, 2).length, 0);
  });
  test('6300 Melrose Ave has cameras within 2 miles', () => {
    assert.ok(near(34.08342, -118.335285, 2).length >= 8);
  });
});
