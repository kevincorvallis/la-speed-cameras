"""Tests for scripts/build_data.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'"""
import contextlib
import copy
import io
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import build_data as b  # noqa: E402


def box(x, y, w=0.002, h=0.0004):
    """A thin east-west rectangle, like a street corridor."""
    return {"type": "Polygon", "coordinates": [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]}


def camera(oid, street, x, y, a="A St", z="B St", system="Under Construction", cid="1-1"):
    return {
        "type": "Feature",
        "id": oid,
        "geometry": {"type": "Point", "coordinates": [x, y]},
        "properties": {"OBJECTID": oid, "ID": cid, "System": system, "StreetName": street, "XStreet1": a, "XStreet2": z},
    }


def corridor(oid, street, x, y, a="A St", z="B St", limit=35, district=1, school="Yes"):
    return {
        "type": "Feature",
        "id": oid,
        "geometry": box(x, y),
        "properties": {
            "OBJECTID": oid, "DISTRICT": district, "StreetName": street, "XStreet1": a, "XStreet2": z,
            "speed_limi": limit, "SchoolNearby": school,
        },
    }


DISTRICTS = [{"type": "Feature", "id": 1, "geometry": box(-119, 33, 2, 2), "properties": {"DISTRICT": 1, "MEMBER": "x"}}]


def run(points, corridors):
    """join() prints notes. Return its result and what it printed."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        result = b.join(copy.deepcopy(points), copy.deepcopy(corridors), copy.deepcopy(DISTRICTS))
    return result, out.getvalue()


class JoinTest(unittest.TestCase):
    def test_joins_by_street_names(self):
        (cameras, corridors, zones), _ = run(
            [camera(1, "Main St", -118.3, 34.0), camera(2, "Oak Ave", -118.2, 34.1)],
            [corridor(10, "Oak Ave", -118.2, 34.1, limit=40, district=7, school="No"),
             corridor(11, "Main St", -118.3, 34.0, limit=25, district=3)],
        )
        by = {c["street"]: c for c in cameras}
        self.assertEqual((by["Main St"]["limit"], by["Main St"]["district"], by["Main St"]["school"]), (25, 3, True))
        self.assertEqual((by["Oak Ave"]["limit"], by["Oak Ave"]["district"], by["Oak Ave"]["school"]), (40, 7, False))
        self.assertEqual({c["properties"]["oid"] for c in corridors}, {1, 2})
        self.assertEqual(zones[0]["properties"], {"district": 1})

    def test_the_name_join_beats_position(self):
        # Two corridors cross. Each camera stands inside the other street's corridor.
        (cameras, _, _), _ = run(
            [camera(1, "Main St", -118.2, 34.1002), camera(2, "Oak Ave", -118.3, 34.0002)],
            [corridor(10, "Main St", -118.3, 34.0, limit=25), corridor(11, "Oak Ave", -118.2, 34.1, limit=45)],
        )
        by = {c["street"]: c for c in cameras}
        self.assertEqual(by["Main St"]["limit"], 25)
        self.assertEqual(by["Oak Ave"]["limit"], 45)

    def test_a_spelling_difference_joins_by_position(self):
        (cameras, corridors, _), printed = run(
            [camera(1, "W King Blvd", -118.2999, 34.0002, z="S Saint Andrew Pl")],
            [corridor(10, "W King Blvd", -118.3, 34.0, z="S Saint Andrews Pl", limit=40)],
        )
        self.assertEqual(cameras[0]["limit"], 40)
        self.assertEqual(corridors[0]["properties"], {"oid": 1})
        self.assertIn("joined by position", printed)

    def test_a_far_corridor_is_not_taken(self):
        # The only spare corridor is about 20 miles away. The camera must not take its limit.
        (cameras, corridors, _), printed = run(
            [camera(1, "New Rd", -118.3, 34.0)],
            [corridor(10, "Old Rd", -118.0, 34.2, limit=55, district=9)],
        )
        self.assertIsNone(cameras[0]["limit"])
        self.assertIsNone(cameras[0]["district"])
        self.assertIsNone(cameras[0]["school"])
        self.assertEqual(corridors, [])
        self.assertIn("WARNING: no corridor", printed)

    def test_a_close_spare_corridor_is_taken(self):
        # About 100 m north of the corridor: close enough.
        (cameras, _, _), _ = run(
            [camera(1, "New Rd", -118.299, 34.0013)],
            [corridor(10, "Old Rd", -118.3, 34.0, limit=30)],
        )
        self.assertEqual(cameras[0]["limit"], 30)

    def test_two_unmatched_cameras_take_their_own_corridors(self):
        (cameras, _, _), _ = run(
            [camera(1, "Alpha", -118.2999, 34.0002), camera(2, "Beta", -118.1999, 34.1002)],
            [corridor(10, "Alfa", -118.3, 34.0, limit=25), corridor(11, "Betta", -118.2, 34.1, limit=45)],
        )
        by = {c["street"]: c["limit"] for c in cameras}
        self.assertEqual(by, {"Alpha": 25, "Beta": 45})

    def test_a_corridor_with_no_camera_is_dropped(self):
        (cameras, corridors, _), _ = run(
            [camera(1, "Main St", -118.3, 34.0)],
            [corridor(10, "Main St", -118.3, 34.0), corridor(11, "Gone Ave", -118.0, 34.3)],
        )
        self.assertEqual(len(cameras), 1)
        self.assertEqual([c["properties"] for c in corridors], [{"oid": 1}])

    def test_duplicate_camera_ids_are_fine(self):
        # LADOT lists "12-6" twice. OBJECTID is the key.
        (cameras, _, _), _ = run(
            [camera(1, "Main St", -118.3, 34.0, cid="12-6"), camera(2, "Oak Ave", -118.2, 34.1, cid="12-6")],
            [corridor(10, "Main St", -118.3, 34.0), corridor(11, "Oak Ave", -118.2, 34.1)],
        )
        self.assertEqual(sorted(c["oid"] for c in cameras), [1, 2])

    def test_duplicate_street_names_stop_the_build(self):
        with self.assertRaises(SystemExit):
            run([camera(1, "Main St", -118.3, 34.0), camera(2, "Main St", -118.2, 34.1)],
                [corridor(10, "Main St", -118.3, 34.0)])

    def test_names_are_trimmed_and_positions_rounded(self):
        (cameras, _, _), _ = run(
            [camera(1, " Main St ", -118.30000049, 34.00000051, a=" A St", z="B St ")],
            [corridor(10, "Main St", -118.3, 34.0)],
        )
        c = cameras[0]
        self.assertEqual((c["street"], c["from"], c["to"]), ("Main St", "A St", "B St"))
        self.assertEqual((c["lon"], c["lat"]), (-118.3, 34.000001))

    def test_a_disputed_limit_is_recorded(self):
        street = ("S La Cienega Blvd", "Coliseum St", "Bowesfield St")
        self.assertIn(street, b.LIMIT_CONFLICTS)
        (cameras, _, _), _ = run(
            [camera(1, street[0], -118.3, 34.0, a=street[1], z=street[2])],
            [corridor(10, street[0], -118.3, 34.0, a=street[1], z=street[2], limit=35)],
        )
        self.assertEqual((cameras[0]["limit"], cameras[0]["limitOther"]), (35, 45))

    def test_no_dispute_when_the_layer_agrees(self):
        street = ("S La Cienega Blvd", "Coliseum St", "Bowesfield St")
        (cameras, _, _), _ = run(
            [camera(1, street[0], -118.3, 34.0, a=street[1], z=street[2])],
            [corridor(10, street[0], -118.3, 34.0, a=street[1], z=street[2], limit=45)],
        )
        self.assertNotIn("limitOther", cameras[0])

    def test_cameras_sort_by_district_then_street(self):
        (cameras, _, _), _ = run(
            [camera(1, "Zed St", -118.3, 34.0), camera(2, "Able St", -118.2, 34.1), camera(3, "Mid St", -118.1, 34.2)],
            [corridor(10, "Zed St", -118.3, 34.0, district=2), corridor(11, "Able St", -118.2, 34.1, district=2),
             corridor(12, "Mid St", -118.1, 34.2, district=1)],
        )
        self.assertEqual([c["street"] for c in cameras], ["Mid St", "Able St", "Zed St"])


class GeometryTest(unittest.TestCase):
    def test_in_geom(self):
        g = box(0, 0, 2, 2)
        self.assertTrue(b.in_geom(1, 1, g))
        self.assertFalse(b.in_geom(3, 1, g))

    def test_in_geom_with_a_hole_and_a_multipolygon(self):
        holed = {"type": "Polygon", "coordinates": [box(0, 0, 4, 4)["coordinates"][0], box(1, 1, 2, 2)["coordinates"][0]]}
        self.assertFalse(b.in_geom(2, 2, holed))
        self.assertTrue(b.in_geom(0.5, 0.5, holed))
        multi = {"type": "MultiPolygon", "coordinates": [box(0, 0, 1, 1)["coordinates"], box(5, 5, 1, 1)["coordinates"]]}
        self.assertTrue(b.in_geom(5.5, 5.5, multi))
        self.assertFalse(b.in_geom(3, 3, multi))

    def test_dist_to_geom_grows_with_distance(self):
        g = box(-118.3, 34.0)
        self.assertLess(b.dist_to_geom(-118.3, 34.001, g), b.dist_to_geom(-118.3, 34.01, g))


class SavedFilesTest(unittest.TestCase):
    """The files in data/ are what join() makes."""

    def test_saved_cameras_have_the_join_fields(self):
        import json
        data = json.loads((pathlib.Path(b.OUT) / "cameras.json").read_text())
        want = {"oid", "district", "street", "from", "to", "lon", "lat", "status", "limit", "school"}
        for cam in data["cameras"]:
            self.assertTrue(want <= set(cam), cam)
            self.assertTrue(set(cam) <= want | {"limitOther"}, cam)

    def test_disputed_limits_are_in_the_saved_copy(self):
        import json
        data = json.loads((pathlib.Path(b.OUT) / "cameras.json").read_text())
        saved = {(c["street"], c["from"], c["to"]): c for c in data["cameras"]}
        for street, other in b.LIMIT_CONFLICTS.items():
            self.assertIn(street, saved, "LIMIT_CONFLICTS names a camera that is not in the saved copy")
            if saved[street]["limit"] != other:
                self.assertEqual(saved[street].get("limitOther"), other)


if __name__ == "__main__":
    unittest.main()
