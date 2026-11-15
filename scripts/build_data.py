#!/usr/bin/env python3
"""Save a copy of LADOT's speed camera data into data/.

Run:  python3 scripts/build_data.py

The app reads camera status live from LADOT. These files are the fallback,
and they hold the parts that do not change (corridors, speed limits, city limits).
"""
import http.client
import json
import math
import pathlib
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "https://services.arcgis.com/G3nmNsarwQblLhip/arcgis/rest/services"
CAMERAS = f"{BASE}/CameraSystems_streetnames2/FeatureServer/0"
CORRIDORS = f"{BASE}/ApprovedLocations_04012026_view/FeatureServer/0"
DISTRICTS = f"{BASE}/LA_City_Council_Districts2026_view/FeatureServer/0"
OUT = pathlib.Path(__file__).resolve().parent.parent / "data"

# LADOT's sources disagree on the speed limit for these cameras. The map layer
# gives one value; LADOT's council district lists (PDFs dated Oct 2026) give another.
# The app shows both. Key: (StreetName, XStreet1, XStreet2) from the camera layer.
LIMIT_CONFLICTS = {
    ("S La Cienega Blvd", "Coliseum St", "Bowesfield St"): 45,  # layer says 35
    ("S Slauson Ave", "Culver Blvd", "Braddock Dr"): 35,  # layer says 25
}

# A camera with no corridor of the same name may take a spare corridor
# only when it stands this close to it (degrees; about 300 m).
MAX_JOIN_DISTANCE = 0.003


def get(url, **params):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except (OSError, http.client.HTTPException):
            if attempt == 2:
                raise


def geojson(layer, **extra):
    q = dict(where="1=1", outFields="*", outSR=4326, f="geojson")
    q.update(extra)
    return get(layer + "/query", **q)["features"]


def rings(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    return geom["coordinates"]


def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_geom(x, y, geom):
    for poly in rings(geom):
        if in_ring(x, y, poly[0]) and not any(in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def dist_to_geom(x, y, geom):
    """Rough distance in degrees to the nearest vertex. Only ranks candidates."""
    k = math.cos(math.radians(y))
    best = float("inf")
    for poly in rings(geom):
        for ring in poly:
            for px, py in ring:
                d = math.hypot((px - x) * k, py - y)
                best = min(best, d)
    return best


def join(points, corridors, districts):
    """Join LADOT's three layers into the app's cameras, corridors and districts.

    Pure: no network, no files. The tests call it with small made-up layers.
    """
    # Join each camera to its corridor by street names. Corridors cross each other,
    # so position alone is ambiguous. A few names differ in spelling: for those,
    # take a spare corridor that the camera stands in or close to.
    # LADOT's camera ID is not unique ("12-6" appears twice), so the key is OBJECTID.
    key = lambda p: tuple(p[k].strip() for k in ("StreetName", "XStreet1", "XStreet2"))
    by_name = {key(c["properties"]): c for c in corridors}
    named = {key(p["properties"]) for p in points}
    if len(by_name) != len(corridors) or len(named) != len(points):
        raise SystemExit("street names are not unique")
    spare = [c for c in corridors if key(c["properties"]) not in named]
    cameras = []
    for p in points:
        x, y = p["geometry"]["coordinates"]
        pp = p["properties"]
        c = by_name.get(key(pp))
        if c is None and spare:
            # A corridor the camera stands in wins. Else the nearest one, if it is close.
            inside = [s for s in spare if in_geom(x, y, s["geometry"])]
            best = inside[0] if len(inside) == 1 else min(spare, key=lambda s: dist_to_geom(x, y, s["geometry"]))
            if inside or dist_to_geom(x, y, best["geometry"]) <= MAX_JOIN_DISTANCE:
                c = best
                spare.remove(c)
                print(f"  joined by position: {key(pp)} -> {key(c['properties'])}")
        if c is None:
            print(f"  WARNING: no corridor for {key(pp)}. It gets no speed limit.")
        cp = c["properties"] if c else {}
        camera = {
            "oid": pp["OBJECTID"],
            "district": cp.get("DISTRICT"),
            "street": pp["StreetName"].strip(),
            "from": pp["XStreet1"].strip(),
            "to": pp["XStreet2"].strip(),
            "lon": round(x, 6),
            "lat": round(y, 6),
            "status": pp["System"],
            "limit": cp.get("speed_limi"),
            "school": cp["SchoolNearby"] == "Yes" if "SchoolNearby" in cp else None,
        }
        other = LIMIT_CONFLICTS.get(key(pp))
        if other is not None and other != camera["limit"]:
            camera["limitOther"] = other
        cameras.append(camera)
        if c:
            c["out"] = {"oid": pp["OBJECTID"]}

    missing = set(LIMIT_CONFLICTS) - named
    if missing:
        print(f"  WARNING: LIMIT_CONFLICTS names cameras LADOT no longer lists: {sorted(missing)}")
    cameras.sort(key=lambda c: (c["district"] or 99, c["street"], c["from"]))
    used = []
    for c in corridors:
        if "out" not in c:
            continue  # a corridor that no camera uses
        used.append({"type": "Feature", "geometry": c["geometry"], "properties": c["out"]})
    zones = [{"type": "Feature", "geometry": d["geometry"], "properties": {"district": d["properties"]["DISTRICT"]}}
             for d in districts]
    return cameras, used, zones


def main():
    OUT.mkdir(exist_ok=True)
    meta = get(CAMERAS, f="json")
    edited = meta.get("editingInfo", {}).get("dataLastEditDate")
    points = geojson(CAMERAS)
    corridors = geojson(CORRIDORS, geometryPrecision=6, maxAllowableOffset=0.00002)
    districts = geojson(DISTRICTS, geometryPrecision=5, maxAllowableOffset=0.0003)
    cameras, corridors, districts = join(points, corridors, districts)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    dump = lambda name, obj: (OUT / name).write_text(json.dumps(obj, separators=(",", ":")))
    dump("cameras.json", {"savedAt": now, "ladotEditedAt": edited, "cameras": cameras})
    dump("corridors.geojson", {"type": "FeatureCollection", "features": corridors})
    dump("city.geojson", {"type": "FeatureCollection", "features": districts})
    print(f"{len(cameras)} cameras, {len(corridors)} corridors, {len(districts)} districts")
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name}: {f.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
