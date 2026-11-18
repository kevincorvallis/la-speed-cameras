// Unit tests for lib.js. Run: node --test tests/unit
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusOf, tally, countOn, miles, inRing, districtAt, milesToGeometry, cameraDistance, circle,
  formatMiles, plural, fold, cleanQuery, placeKey, placeFromText, placeFromPhoton, tidyParcel,
  placeFromCandidate, looksLike, mergeSuggestions, decideOnEnter, decideFromSuggestions,
  streetKey, mergeLive, signature, layoutSigns, snapFor,
  formatParams, parseParams, bareURL,
} from '../../lib.js';

const place = (text, extra) => placeFromText(text, extra);
const cand = (address, score, type, lat = 34, lon = -118.3) =>
  placeFromCandidate({ address, score, location: { x: lon, y: lat }, attributes: { Addr_type: type } });

describe('statusOf', () => {
  test('names LADOT\'s three values', () => {
    assert.equal(statusOf('Under Construction').key, 'build');
    assert.equal(statusOf('Warning Live').key, 'warn');
    assert.equal(statusOf('Citation Live').key, 'fine');
    assert.equal(statusOf('  warning live ').label, 'Warning period');
  });
  test('keeps LADOT\'s text for a value it does not know', () => {
    const st = statusOf('Paused for repair');
    assert.equal(st.key, 'other');
    assert.equal(st.label, 'Paused for repair');
    assert.match(st.tally(2), /2 are listed as “Paused for repair”/);
  });
  test('an unknown value that mentions tickets counts as fining', () => {
    assert.equal(statusOf('Enforcement active').key, 'fine');
  });
  test('object keys are not statuses', () => {
    for (const raw of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const st = statusOf(raw);
      assert.equal(st.key, 'other');
      assert.equal(typeof st.tally, 'function');
    }
  });
  test('empty and missing values', () => {
    assert.equal(statusOf(null).label, 'Status not listed');
    assert.equal(statusOf(undefined).key, 'other');
    assert.equal(statusOf(42).label, '42');
  });
  test('tally words agree in number', () => {
    assert.equal(statusOf('Warning Live').tally(1), '1 is in the warning period');
    assert.equal(statusOf('Warning Live').tally(3), '3 are in the warning period');
    assert.equal(statusOf('Citation Live').tally(1), '1 is issuing tickets');
    assert.equal(statusOf('Under Construction').tally(2), '2 are under construction');
    assert.equal(statusOf('Under Construction').label, 'Under construction');
  });
});

describe('tally and countOn', () => {
  const cams = [
    { status: 'Under Construction' }, { status: 'Warning Live' }, { status: 'Citation Live' },
    { status: 'Warning Live' }, { status: 'Mystery' },
  ];
  test('groups in order: fine, warn, other, build', () => {
    assert.deepEqual(tally(cams).map((g) => [g.st.key, g.n]), [['fine', 1], ['warn', 2], ['other', 1], ['build', 1]]);
  });
  test('an unknown status does not count as active', () => {
    assert.equal(countOn(cams), 3);
    assert.equal(countOn([{ status: 'Renamed' }, { status: 'Renamed' }]), 0);
  });
});

describe('distance', () => {
  test('haversine matches known distances', () => {
    // LA City Hall to Santa Monica Pier is about 14.9 miles.
    const d = miles(34.0537, -118.2428, 34.0094, -118.4973);
    assert.ok(d > 14.6 && d < 15.2, `got ${d}`);
    assert.equal(miles(34, -118, 34, -118), 0);
  });
  test('one degree of latitude is about 69.09 miles', () => {
    assert.ok(Math.abs(miles(34, -118, 35, -118) - 69.09) < 0.02);
  });
  const square = { type: 'Polygon', coordinates: [[[-118.3, 34.0], [-118.29, 34.0], [-118.29, 34.01], [-118.3, 34.01], [-118.3, 34.0]]] };
  test('inside a polygon the distance is 0', () => {
    assert.equal(milesToGeometry(square, 34.005, -118.295), 0);
  });
  test('outside, it is the distance to the nearest edge, not the nearest corner', () => {
    // Due south of the middle of the south edge by 0.01 degrees of latitude.
    const d = milesToGeometry(square, 33.99, -118.295);
    assert.ok(Math.abs(d - 0.6909) < 0.003, `got ${d}`);
    const toCorner = miles(33.99, -118.295, 34.0, -118.3);
    assert.ok(d < toCorner);
  });
  test('a camera counts from the nearest part of its stretch', () => {
    const cam = { lat: 34.009, lon: -118.291 }; // label point at the far end
    const viaPoint = cameraDistance(33.99, -118.295, cam, null);
    const viaStretch = cameraDistance(33.99, -118.295, cam, square);
    assert.ok(viaStretch < viaPoint);
    assert.ok(Math.abs(viaStretch - 0.6909) < 0.003);
  });
  test('the point wins when it is nearer than the stretch', () => {
    const cam = { lat: 33.99, lon: -118.295 };
    assert.equal(cameraDistance(33.99, -118.295, cam, square), 0);
  });
  test('a multipolygon and a hole', () => {
    const holed = { type: 'Polygon', coordinates: [square.coordinates[0], [[-118.297, 34.003], [-118.293, 34.003], [-118.293, 34.007], [-118.297, 34.007], [-118.297, 34.003]]] };
    assert.ok(milesToGeometry(holed, 34.005, -118.295) > 0, 'a point in the hole is outside');
    const multi = { type: 'MultiPolygon', coordinates: [square.coordinates, [[[-118.2, 34], [-118.19, 34], [-118.19, 34.01], [-118.2, 34.01], [-118.2, 34]]]] };
    assert.equal(milesToGeometry(multi, 34.005, -118.195), 0);
  });
});

describe('districtAt', () => {
  const city = {
    features: [
      { properties: { district: 4 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
      { properties: { district: 9 }, geometry: { type: 'MultiPolygon', coordinates: [[[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]]] } },
    ],
  };
  test('finds the district', () => {
    assert.equal(districtAt(city, 0.5, 0.5), 4);
    assert.equal(districtAt(city, 2.5, 0.5), 9);
  });
  test('null outside the city', () => {
    assert.equal(districtAt(city, 1.5, 0.5), null);
  });
  test('inRing handles a concave ring', () => {
    const ring = [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4], [0, 0]];
    assert.equal(inRing(2, 0.5, ring), true);
    assert.equal(inRing(2, 3, ring), false);
  });
});

describe('circle', () => {
  test('every point is the radius away', () => {
    const ring = circle(34.05, -118.25, 2).geometry.coordinates[0];
    assert.equal(ring.length, 97);
    assert.deepEqual(ring[0], ring.at(-1));
    for (const [lon, lat] of ring) {
      assert.ok(Math.abs(miles(34.05, -118.25, lat, lon) - 2) < 0.01);
    }
  });
});

describe('formatMiles', () => {
  test('feet, tenths and whole miles', () => {
    assert.equal(formatMiles(0.03), '160 ft');
    assert.equal(formatMiles(0.001), '10 ft');
    assert.equal(formatMiles(0.77), '0.8 mi');
    assert.equal(formatMiles(3.44), '3.4 mi');
    assert.equal(formatMiles(12.6), '13 mi');
  });
  test('near a search radius it never rounds across it', () => {
    assert.equal(formatMiles(2.04), '2.04 mi'); // outside 2 miles: must not read "2.0 mi"
    assert.equal(formatMiles(2.004), '2.01 mi');
    assert.equal(formatMiles(1.996), '1.99 mi');
    assert.equal(formatMiles(0.99), '0.99 mi');
    assert.equal(formatMiles(4.979), '4.97 mi');
    assert.equal(formatMiles(2), '2.0 mi');
  });
  test('no distance, no text', () => {
    assert.equal(formatMiles(Infinity), '');
    assert.equal(formatMiles(NaN), '');
  });
  test('plural', () => {
    assert.equal(plural(1, 'camera'), '1 camera');
    assert.equal(plural(0, 'camera'), '0 cameras');
  });
});

describe('address text', () => {
  test('fold strips accents', () => {
    assert.equal(fold('César E. Chávez'), 'cesar e. chavez');
  });
  test('cleanQuery drops units and fractions', () => {
    assert.equal(cleanQuery('742 S Hobart Blvd Apt 12'), '742 S Hobart Blvd');
    assert.equal(cleanQuery('1234 W 23rd St #4'), '1234 W 23rd St');
    assert.equal(cleanQuery('1234 1/2 W 23rd St'), '1234 W 23rd St');
    assert.equal(cleanQuery('500 Broadway Unit B'), '500 Broadway');
    assert.equal(cleanQuery('1 Unity Way'), '1 Unity Way', 'a street that starts like "unit" stays');
  });
  test('placeFromText splits title, sub and label', () => {
    assert.deepEqual(place('6300 Melrose Ave, Los Angeles, 90038'), {
      title: '6300 Melrose Ave', sub: 'Los Angeles, 90038', label: '6300 Melrose Ave, Los Angeles',
    });
    assert.equal(place('UCLA').label, 'UCLA');
    assert.equal(place('Sepulveda Blvd, 90266').label, 'Sepulveda Blvd');
    assert.equal(place(''), null);
    assert.equal(place(null), null);
    assert.equal(place(' , , '), null);
  });
  test('placeKey treats long and short street words as one place', () => {
    assert.equal(
      placeKey(place('200 North Spring Street, Los Angeles, 90012')),
      placeKey(place('200 N Spring St, Los Angeles CA, 90012')),
    );
    assert.notEqual(
      placeKey(place('200 North Spring Street, Los Angeles, 90012')),
      placeKey(place('200 South Spring Street, Los Angeles, 90012')),
    );
  });
  test('tidyParcel removes the parcel number and the shouting', () => {
    assert.equal(tidyParcel('5037032049, 3900 S FIGUEROA ST, LOS ANGELES CA, 90037'), '3900 S Figueroa St, Los Angeles, 90037');
    assert.equal(tidyParcel('5131020025, 1234 E 23RD ST, LOS ANGELES CA, 90011'), '1234 E 23rd St, Los Angeles, 90011');
  });
  test('placeFromCandidate needs finite coordinates', () => {
    assert.equal(placeFromCandidate({ address: 'X', location: { x: 'NaN', y: 1 } }), null);
    assert.equal(placeFromCandidate(undefined), null);
    const p = cand('5037032049, 3900 S FIGUEROA ST, LOS ANGELES CA, 90037', 97.1, 'Parcel');
    assert.equal(p.title, '3900 S Figueroa St');
    assert.equal(p.type, 'Parcel');
    assert.equal(p.score, 97.1);
  });
  test('placeFromPhoton', () => {
    const f = { geometry: { coordinates: [-118.24, 34.07] }, properties: { name: 'Dodger Stadium', housenumber: '1000', street: 'Vin Scully Avenue', city: 'Los Angeles', state: 'California', postcode: '90012' } };
    assert.deepEqual(placeFromPhoton(f), {
      lat: 34.07, lon: -118.24, title: 'Dodger Stadium', sub: '1000 Vin Scully Avenue, Los Angeles, California, 90012', label: 'Dodger Stadium, Los Angeles',
    });
    assert.equal(placeFromPhoton({ properties: { name: 'x' } }), null);
    assert.equal(placeFromPhoton({ geometry: { coordinates: [1, 2] }, properties: {} }), null);
  });
});

describe('looksLike', () => {
  test('words that are also Object property names do not throw', () => {
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(looksLike(word, place(`${word} St, Los Angeles`)), true);
      assert.equal(looksLike(`100 ${word} ave`, place('100 Main St, Los Angeles')), false);
    }
  });
  const melrose = place('6300 Melrose Ave, Los Angeles, 90038');
  test('fits a partial and a full address', () => {
    assert.ok(looksLike('6300 mel', melrose));
    assert.ok(looksLike('6300 Melrose', melrose));
    assert.ok(looksLike('6300 Melrose Avenue, Los Angeles', melrose));
    assert.ok(looksLike('6300 Melrose Blvd', melrose), 'a wrong street type is forgiven');
  });
  test('numbers must match in full', () => {
    assert.ok(!looksLike('630 Melrose', melrose));
    assert.ok(!looksLike('1234', place('12342, Garden Grove')));
    assert.ok(looksLike('90026', place('90026, Los Angeles')));
  });
  test('nonsense does not fit', () => {
    assert.ok(!looksLike('zzqqxx blorp 99', place('E 99th St, Inglewood, 90301')));
    assert.ok(!looksLike('!!!', place('., Pasadena')));
    assert.ok(!looksLike('', melrose));
    assert.ok(!looksLike('asdf', place('ASF Parking, Burbank')));
  });
  test('a named city must be in the place', () => {
    assert.ok(!looksLike('100 Harbor Dr, San Diego', place('100 N Harbor Dr, Redondo Beach, 90277')));
    assert.ok(looksLike('1685 Main St, Santa Monica', place('1685 Main St, Santa Monica, 90401')));
  });
  test('north is never south', () => {
    assert.ok(!looksLike('200 N Spring St', place('200 South Spring Street, Los Angeles, 90012')));
    assert.ok(looksLike('200 N Spring St', place('200 North Spring Street, Los Angeles, 90012')));
    assert.ok(looksLike('1234 hobart', place('1234 N Hobart Blvd, Los Angeles, 90029')), 'no direction typed: both fit');
    assert.ok(looksLike('1234 hobart', place('1234 S Hobart Blvd, Los Angeles, 90006')));
    assert.ok(looksLike('1st and soto', place('E 1st St & S Soto St, Los Angeles, 90033')), 'two directions in the place: no veto');
  });
  test('one wrong letter in a long word is forgiven', () => {
    assert.ok(looksLike('3900 s figeroa st', place('3900 South Figueroa Street, Los Angeles, 90037')));
    assert.ok(looksLike('wilshere blvd and western', place('Wilshire Blvd & S Western Ave, Los Angeles, 90010')));
    assert.ok(looksLike('12000 sepulvida blvd', place('12000 Sepulveda Blvd, Los Angeles, 90064')));
    assert.ok(!looksLike('vine', place('Pine St, Long Beach')), 'short words must match');
  });
  test('units, fractions and accents are ignored', () => {
    assert.ok(looksLike('742 S Hobart Blvd Apt 12', place('742 S Hobart Blvd, Los Angeles, 90005')));
    assert.ok(looksLike('1234 1/2 W 23rd St', place('1234 W 23rd St, Los Angeles, 90007')));
    assert.ok(looksLike('César E. Chávez Ave', place('Cesar E Chavez Ave, Los Angeles, 90033')));
  });
  test('a query of filler words still has to match', () => {
    assert.ok(looksLike('Los Angeles', place('Los Angeles St, Baldwin Park')));
    assert.ok(!looksLike('Los Angeles', place('Venice Blvd, Culver City')));
  });
});

describe('mergeSuggestions', () => {
  test('fits first, county before Photon, no duplicates, at most seven', () => {
    const county = [place('Stadium Ct, Lancaster, 93535'), place('Stadium Way, Los Angeles, 90012')];
    const photon = [{ title: 'Dodger Stadium', sub: 'Los Angeles, California, 90012', label: 'Dodger Stadium, Los Angeles', lat: 1, lon: 2 }];
    const out = mergeSuggestions('dodger stadium', county, photon);
    assert.equal(out[0].title, 'Dodger Stadium');
    assert.equal(out.length, 3);
    const dup = mergeSuggestions('200 spring', [place('200 South Spring Street, Los Angeles, 90012'), place('200 S Spring St, Los Angeles, 90012')]);
    assert.equal(dup.length, 1);
    const many = Array.from({ length: 12 }, (_, i) => place(`${i} Main St, Town, 9000${i % 10}`));
    assert.equal(mergeSuggestions('main', many).length, 7);
  });
  test('survives empty and null entries', () => {
    assert.deepEqual(mergeSuggestions('x', [], []), []);
    assert.equal(mergeSuggestions('main', [null, place('1 Main St, A, 90001')]).length, 1);
  });
});

describe('decideOnEnter', () => {
  test('one strong address is picked', () => {
    const out = decideOnEnter('6300 melrose', [cand('6300 Melrose Ave, Los Angeles, 90038', 97.5, 'StreetAddress')]);
    assert.equal(out.pick.title, '6300 Melrose Ave');
  });
  test('a parcel and an address for the same place are one place', () => {
    const out = decideOnEnter('200 n spring st', [
      cand('200 North Spring Street, Los Angeles, 90012', 100, 'PointAddress'),
      cand('5161005906, 200 N SPRING ST, LOS ANGELES CA, 90012', 100, 'Parcel'),
      cand('200 Spring St, Claremont, 91711', 97.66, 'StreetAddress'),
    ]);
    assert.equal(out.pick.title, '200 North Spring Street', 'the address wins over the parcel');
  });
  test('the same address in three cities is a choice, not a guess', () => {
    const out = decideOnEnter('1234 W 23rd St', [
      cand('1234 West 23Rd Street, San Pedro, 90731', 100, 'PointAddress'),
      cand('1234 W 23rd St, Long Beach, 90810', 100, 'StreetAddress'),
      cand('1234 W 23rd St, Los Angeles, 90007', 100, 'StreetAddress'),
      cand('1234 23rd St, Manhattan Beach, 90266', 97.66, 'StreetAddress'),
    ]);
    assert.equal(out.pick, undefined);
    assert.equal(out.choices.length, 3);
  });
  test('a street name alone is never picked', () => {
    assert.equal(decideOnEnter('The Grove', [cand('The Groves, Palmdale, 93551', 100, 'StreetName')]), null);
    assert.equal(decideOnEnter('Venice', [cand('Venice St, Carson, 90745', 94.9, 'StreetName')]), null);
  });
  test('a place of interest needs the exact name', () => {
    assert.equal(decideOnEnter('UCLA', [cand('UCLA', 100, 'POI')]).pick.title, 'UCLA');
    assert.equal(decideOnEnter('Koreatown', [cand('Koreatown Plaza Shopping Center', 100, 'POI')]), null);
  });
  test('a weak score or a wrong city is not picked', () => {
    assert.equal(decideOnEnter('LAX', [cand('Los Angeles International Airport (LAX)', 76, 'POI')]), null);
    assert.equal(decideOnEnter('100 Harbor Dr, San Diego', [cand('100 N Harbor Dr, Redondo Beach, 90277', 95, 'StreetAddress')]), null);
  });
  test('an intersection is strong', () => {
    const out = decideOnEnter('Sunset & Vine', [cand('W Sunset Blvd & Vine St, Los Angeles, 90028', 98.8, 'StreetInt')]);
    assert.equal(out.pick.title, 'W Sunset Blvd & Vine St');
  });
  test('only parcels: a parcel is picked with a clean label', () => {
    const out = decideOnEnter('3900 s figeroa st', [
      cand('5037032049, 3900 S FIGUEROA ST, LOS ANGELES CA, 90037', 97.14, 'Parcel'),
      cand('5451006020, 3900 N FIGUEROA ST, LOS ANGELES CA, 90065', 94.7, 'Parcel'),
    ]);
    assert.equal(out.pick.label, '3900 S Figueroa St, Los Angeles');
  });
  test('nothing to decide from', () => {
    assert.equal(decideOnEnter('x', []), null);
    assert.equal(decideOnEnter('x', [null]), null);
  });
});

describe('decideFromSuggestions', () => {
  test('one fit is picked', () => {
    const out = decideFromSuggestions('90026', [place('90026, Los Angeles')]);
    assert.equal(out.pick.title, '90026');
  });
  test('two fits are a choice', () => {
    const out = decideFromSuggestions('1234 hobart', [place('1234 N Hobart Blvd, Los Angeles, 90029'), place('1234 S Hobart Blvd, Los Angeles, 90006')]);
    assert.equal(out.reason, 'many');
    assert.equal(out.choices.length, 2);
  });
  test('no fit shows the close ones, and says so', () => {
    const out = decideFromSuggestions('zzqqxx blorp 99', [place('E 99th St, Inglewood, 90301')]);
    assert.equal(out.reason, 'close');
    assert.equal(out.pick, undefined);
    assert.equal(decideFromSuggestions('zzqqxx', []).reason, 'none');
  });
});

describe('mergeLive', () => {
  const saved = Array.from({ length: 60 }, (_, i) => ({
    oid: i + 1, district: 1, street: `Street ${i}`, from: 'A St', to: 'B St',
    lon: -118.3 + i * 0.01, lat: 34, status: 'Under Construction', limit: 35, limitOther: null, school: true,
  }));
  const feature = (c, props = {}) => ({
    geometry: { coordinates: [c.lon, c.lat] },
    properties: { OBJECTID: c.oid, System: 'Warning Live', StreetName: c.street, XStreet1: c.from, XStreet2: c.to, ...props },
  });
  test('a broken position from LADOT keeps the saved place and takes the live status', () => {
    // One latitude of 91 once reached the map, which threw and stopped every search.
    for (const bad of [[saved[3].lon, 91], [0, 0], [NaN, saved[3].lat], [-122.4, 37.8]]) {
      const feats = saved.map((c) => feature(c, { System: 'Citation Live' }));
      feats[3].geometry.coordinates = bad;
      const out = mergeLive(saved, feats);
      assert.equal(out.length, 60);
      assert.equal(out[3].lat, saved[3].lat);
      assert.equal(out[3].lon, saved[3].lon);
      assert.equal(out[3].status, 'Citation Live');
    }
  });
  test('a new camera with a broken position is left out', () => {
    const extra = { oid: 999, street: 'New St', from: 'A St', to: 'B St', lon: -118.3, lat: 91 };
    const out = mergeLive(saved, [...saved.map((c) => feature(c)), feature(extra)]);
    assert.equal(out.length, 60);
    assert.ok(!out.some((c) => c.street === 'New St'));
  });
  test('every merged camera has a position the map can draw', () => {
    const feats = saved.map((c, i) => feature(i % 7 ? c : { ...c, lat: -400 }));
    for (const c of mergeLive(saved, feats)) {
      assert.ok(c.lat > 33 && c.lat < 35 && c.lon > -120 && c.lon < -117, `${c.lat}, ${c.lon}`);
    }
  });
  test('takes the live status and keeps the saved limit', () => {
    const out = mergeLive(saved, saved.map((c) => feature(c)));
    assert.equal(out.length, 60);
    assert.ok(out.every((c) => c.status === 'Warning Live' && c.limit === 35));
    assert.equal(out[0].oid, 1);
  });
  test('a changed street spelling still matches by position', () => {
    const feats = saved.map((c) => feature(c));
    feats[3].properties.StreetName = 'Street Three Renamed';
    const out = mergeLive(saved, feats);
    assert.equal(out[3].oid, 4);
    assert.equal(out[3].limit, 35);
    assert.equal(out[3].street, 'Street Three Renamed');
  });
  test('a new camera gets a new id and no limit', () => {
    const extra = { oid: 999, street: 'New Rd', from: 'X', to: 'Y', lon: -117.9, lat: 34.5 };
    const out = mergeLive(saved, [...saved.map((c) => feature(c)), feature(extra)], () => 7);
    const added = out.at(-1);
    assert.equal(added.oid, 'new-999');
    assert.equal(added.limit, null);
    assert.equal(added.district, 7);
  });
  test('a camera LADOT removed is gone', () => {
    const out = mergeLive(saved, saved.slice(0, 55).map((c) => feature(c)));
    assert.equal(out.length, 55);
  });
  test('throws when LADOT renames the status field', () => {
    const feats = saved.map((c) => {
      const f = feature(c);
      f.properties.Status2 = f.properties.System;
      delete f.properties.System;
      return f;
    });
    assert.throws(() => mergeLive(saved, feats), /too few usable/);
  });
  test('throws when the street names no longer match and positions moved', () => {
    const feats = saved.map((c) => feature({ ...c, street: `Other ${c.oid}`, lat: 34.5 }));
    assert.throws(() => mergeLive(saved, feats), /no longer matches/);
    // Renamed and placed outside Los Angeles: nothing usable is left.
    const away = saved.map((c) => feature({ ...c, street: `Other ${c.oid}`, lat: 36 }));
    assert.throws(() => mergeLive(saved, away), /too few/);
  });
  test('throws on too few cameras or a wrong shape', () => {
    assert.throws(() => mergeLive(saved, saved.slice(0, 10).map((c) => feature(c))), /too few/);
    assert.throws(() => mergeLive(saved, null), /too few/);
    assert.throws(() => mergeLive(saved, { error: 'x' }), /too few/);
  });
  test('a feature with no position keeps the saved place when its streets match', () => {
    const feats = saved.map((c) => feature(c));
    feats[0].geometry = null;
    feats[1].geometry.coordinates = ['a', 'b'];
    const out = mergeLive(saved, feats);
    assert.equal(out.length, 60);
    assert.deepEqual([out[0].lon, out[0].lat, out[1].lon, out[1].lat], [saved[0].lon, saved[0].lat, saved[1].lon, saved[1].lat]);
  });
  test('skips a feature with no position and no saved camera to match', () => {
    const feats = saved.map((c) => feature(c));
    feats[0] = { geometry: null, properties: { ...feats[0].properties, StreetName: 'Nowhere Rd' } };
    feats[1] = { geometry: { coordinates: ['a', 'b'] }, properties: { ...feats[1].properties, StreetName: 'Nowhere Ave' } };
    assert.equal(mergeLive(saved, feats).length, 58);
  });
  test('coordinates come out as numbers', () => {
    const feats = saved.map((c) => feature(c));
    feats[0].geometry.coordinates = ['-118.3', '34'];
    const out = mergeLive(saved, feats);
    assert.equal(typeof out[0].lon, 'number');
    assert.equal(out[0].oid, 1);
  });
  test('signature changes with status, not with order of keys', () => {
    const a = mergeLive(saved, saved.map((c) => feature(c)));
    const b = mergeLive(saved, saved.map((c) => feature(c, c.oid === 5 ? { System: 'Citation Live' } : {})));
    assert.notEqual(signature(a), signature(b));
    assert.equal(signature(a), signature(mergeLive(saved, saved.map((c) => feature(c)))));
  });
  test('streetKey ignores case, spaces and accents', () => {
    assert.equal(streetKey(' N Vine St ', 'A', 'B'), streetKey('n vine st', 'a', 'b'));
  });
});

describe('layoutSigns', () => {
  const size = { width: 400, height: 400 };
  test('two signs on one spot: the first keeps the sign', () => {
    const { signs } = layoutSigns([
      { id: 'a', x: 100, y: 100, wants: true }, { id: 'b', x: 110, y: 105, wants: true }, { id: 'c', x: 300, y: 300, wants: true },
    ], size);
    assert.deepEqual([...signs].sort(), ['a', 'c']);
  });
  test('no two signs overlap, whatever the input', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const items = Array.from({ length: 125 }, (_, i) => ({ id: i, x: rnd() * 400, y: rnd() * 400, wants: true }));
    const { signs } = layoutSigns(items, size);
    const boxes = items.filter((it) => signs.has(it.id));
    assert.ok(boxes.length > 5);
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        assert.ok(Math.abs(a.x - b.x) >= 36 || Math.abs(a.y - b.y) >= 42, `signs ${a.id} and ${b.id} overlap`);
      }
    }
  });
  test('a marker that does not want a sign stays a dot', () => {
    const { signs } = layoutSigns([{ id: 'a', x: 10, y: 10, wants: false }], size);
    assert.equal(signs.size, 0);
  });
  test('off-screen markers get no sign and leave the tab order', () => {
    const { signs, onScreen } = layoutSigns([
      { id: 'in', x: 10, y: 10, wants: true }, { id: 'out', x: -50, y: 10, wants: true }, { id: 'far', x: 10, y: 900, wants: true },
    ], size);
    assert.deepEqual([...onScreen], ['in']);
    assert.deepEqual([...signs], ['in']);
  });
  test('the selected camera always gets its sign', () => {
    const { signs } = layoutSigns([
      { id: 'a', x: 100, y: 100, wants: true }, { id: 'sel', x: 105, y: 100, wants: false, selected: true },
    ], size);
    assert.ok(signs.has('sel'));
  });
});

describe('snapFor', () => {
  const snaps = { peek: 176, half: 400, full: 700 };
  test('settles on the nearest size', () => {
    assert.equal(snapFor(190, 0, snaps), 'peek');
    assert.equal(snapFor(420, 0, snaps), 'half');
    assert.equal(snapFor(600, 0, snaps), 'full');
  });
  test('a flick carries to the next size', () => {
    assert.equal(snapFor(300, 1.5, snaps), 'full');
    assert.equal(snapFor(450, -1.2, snaps), 'peek');
  });
});

describe('formatParams and parseParams', () => {
  test('overview produces an empty query string', () => {
    assert.equal(formatParams({ mode: 'near', origin: null, radius: 2, trip: null, selected: null }), '');
    assert.deepEqual(parseParams(''), {
      mode: 'near', origin: null, radius: 2, from: null, to: null, routeKind: 'fast', selected: null,
    });
  });
  test('round-trips an address search with non-default radius and camera', () => {
    const qs = formatParams({
      mode: 'near',
      origin: { lat: 34.08342, lon: -118.33528, label: '6300 Melrose Ave, Los Angeles', kind: 'address' },
      radius: 5,
      selected: 42,
    });
    assert.deepEqual(parseParams(qs), {
      mode: 'near',
      origin: { lat: 34.08342, lon: -118.33528, label: '6300 Melrose Ave, Los Angeles', kind: 'address' },
      radius: 5,
      from: null,
      to: null,
      routeKind: 'fast',
      selected: 42,
    });
  });
  test('round-trips a drive with both ends and route preference', () => {
    const qs = formatParams({
      mode: 'trip',
      trip: {
        from: { lat: 34.05405, lon: -118.24318, label: '200 North Spring Street, Los Angeles', kind: 'address' },
        to: { lat: 34.01166, lon: -118.49224, label: '1685 Main St, Santa Monica', kind: 'address' },
        routes: [{ kind: 'fast' }, { kind: 'streets' }],
        pick: 1,
      },
      selected: null,
    });
    assert.deepEqual(parseParams(qs), {
      mode: 'trip',
      origin: null,
      radius: 2,
      from: { lat: 34.05405, lon: -118.24318, label: '200 North Spring Street, Los Angeles', kind: 'address' },
      to: { lat: 34.01166, lon: -118.49224, label: '1685 Main St, Santa Monica', kind: 'address' },
      routeKind: 'streets',
      selected: null,
    });
  });
  test('GPS coordinates never go into the URL', () => {
    const qs = formatParams({
      mode: 'trip',
      trip: {
        from: { lat: 34.08, lon: -118.33, label: 'Your location', kind: 'gps' },
        to: { lat: 34.01166, lon: -118.49224, label: '1685 Main St, Santa Monica', kind: 'address' },
        routes: [],
        pick: 0,
      },
    });
    assert.ok(!qs.includes('34.08'));
    assert.ok(!qs.includes('from='));
    assert.equal(formatParams({ mode: 'near', origin: { lat: 34.08, lon: -118.33, label: 'Your location', kind: 'gps' }, radius: 5 }), '');
  });
  test('ignores out-of-range coordinates and unknown values', () => {
    const parsed = parseParams('?drive=1&from=999,-118&fromName=Bad&to=34,-118&mi=99&route=bogus');
    assert.equal(parsed.from, null);
    assert.equal(parsed.to, null);
    assert.equal(parsed.radius, 2);
    assert.equal(parsed.routeKind, 'fast');
  });
});

describe('bareURL', () => {
  test('cuts the address a share link holds', () => {
    const link = 'https://laspeedcams.com/?at=34.08342,-118.33528&place=6300+Melrose+Ave%2C+Los+Angeles&mi=5';
    assert.equal(bareURL(link), 'https://laspeedcams.com/');
    assert.equal(bareURL('https://laspeedcams.com/?drive=1&fromName=City+Hall#top'), 'https://laspeedcams.com/');
  });
  test('leaves an address with no query as it is', () => {
    assert.equal(bareURL('https://laspeedcams.com/'), 'https://laspeedcams.com/');
    assert.equal(bareURL(undefined), undefined);
  });
});
