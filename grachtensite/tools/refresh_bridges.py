#!/usr/bin/env python3
"""Regenerate data/bridges.geojson from Gemeente Amsterdam's open civil-
structures dataset (civieleconstructies/brug).

Why this exists: the app used to fetch bridge locations live from Overpass
on every page load, which reliably timed out on this app's hosting provider
(see git history / CLAUDE.md). Bridge locations barely change, so they are
now a static file checked into the repo, refreshed by running this script
occasionally rather than fetched per-request.

Note on data completeness: this official dataset gives location, bridge
type (fixed vs. movable) and material, but does NOT publish clearance
dimensions (width/height). We deliberately do not invent numbers for that;
the app instead links to the official Rijkswaterstaat Vaarweginformatie map
for current clearance and opening-hours detail. See RWS_INTEGRATION.md.

Usage:
    python3 tools/refresh_bridges.py
    (run from anywhere; paths below are relative to this file)
"""
import json
import os
import time
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
CANALS_PATH = os.path.join(DATA_DIR, "Amsterdamcanals.geojson")
OUTPUT_PATH = os.path.join(DATA_DIR, "bridges.geojson")

API_BASE = "https://api.data.amsterdam.nl/v1/civieleconstructies/brug/"
USER_AGENT = "SmoothOperator/1.0 (student project data refresh)"
MAX_DISTANCE_FROM_CANAL_M = 30.0  # only keep bridges that actually cross a navigable canal


def rd_to_wgs84(x, y):
    """Approximate RD New (EPSG:28992) -> WGS84 conversion (accurate to ~1 m for NL)."""
    x0, y0 = 155000.0, 463000.0
    phi0, lam0 = 52.15517440, 5.38720621
    kp = [
        (0, 1, 3235.65389), (2, 0, -32.58297), (0, 2, -0.24750), (2, 1, -0.84978),
        (0, 3, -0.06550), (2, 2, -0.01709), (1, 0, -0.00738), (4, 0, 0.00530),
        (2, 3, -0.00039), (4, 1, 0.00033), (1, 1, -0.00012),
    ]
    kq = [
        (1, 0, 5260.52916), (1, 1, 105.94684), (1, 2, 2.45656), (3, 0, -0.81885),
        (1, 3, 0.05594), (3, 1, -0.05607), (0, 1, 0.01199), (3, 2, -0.00256),
        (1, 4, 0.00128), (0, 2, 0.00022), (2, 0, -0.00022), (5, 0, 0.00026),
    ]
    dx = (x - x0) * 1e-5
    dy = (y - y0) * 1e-5
    phi = phi0 + sum(c * dx**a * dy**b for a, b, c in kp) / 3600.0
    lam = lam0 + sum(c * dx**a * dy**b for a, b, c in kq) / 3600.0
    return phi, lam  # lat, lon


def polygon_centroid(coords):
    ring = coords[0]
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def fetch_all_bridges():
    url = f"{API_BASE}?_format=json&_pageSize=100"
    items = []
    for _ in range(50):  # safety cap on pagination
        if not url:
            break
        req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/hal+json"})
        with urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        items.extend(payload.get("_embedded", {}).get("brug", []))
        url = payload.get("_links", {}).get("next", {}).get("href")
        time.sleep(0.2)
    return items


def to_point_feature(item):
    geometry = item.get("geometrie")
    if not geometry or geometry.get("type") not in ("Polygon", "Point", "LineString"):
        return None
    if geometry["type"] == "Point":
        x, y = geometry["coordinates"]
    elif geometry["type"] == "Polygon":
        x, y = polygon_centroid(geometry["coordinates"])
    else:
        pts = geometry["coordinates"]
        x = sum(p[0] for p in pts) / len(pts)
        y = sum(p[1] for p in pts) / len(pts)

    lat, lon = rd_to_wgs84(x, y)
    if not (52.25 <= lat <= 52.50 and 4.70 <= lon <= 5.10):
        return None  # outside the greater Amsterdam area

    bridge_type_raw = (item.get("type") or "").strip().lower()
    is_movable = "beweeg" in bridge_type_raw
    name = item.get("objectnaam") or item.get("objectnummer") or "Bridge"

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        "properties": {
            "name": name,
            "object_number": item.get("objectnummer"),
            "bridge_type": "Movable bridge" if is_movable else "Fixed bridge",
            "material": item.get("materiaal"),
            "manager": item.get("beheerder"),
            "manager_area": item.get("beheergebied"),
            "source": "Gemeente Amsterdam – civiele constructies (open data)",
            "source_url": "https://api.data.amsterdam.nl/v1/civieleconstructies/brug/",
        },
    }


def load_canal_segments():
    canals = json.load(open(CANALS_PATH, encoding="utf-8"))
    segments = []
    for feature in canals.get("features", []):
        if str((feature.get("properties") or {}).get("fclass", "")).lower() != "canal":
            continue
        geometry = feature.get("geometry") or {}
        lines = []
        if geometry.get("type") == "LineString":
            lines = [geometry["coordinates"]]
        elif geometry.get("type") == "MultiLineString":
            lines = geometry["coordinates"]
        for line in lines:
            for i in range(len(line) - 1):
                segments.append((line[i], line[i + 1]))
    return segments


def point_to_segment_m(p, a, b):
    import math
    lat_scale = 111320.0
    lng_scale = 111320.0 * math.cos(math.radians(p[1]))
    px, py = p[0] * lng_scale, p[1] * lat_scale
    ax, ay = a[0] * lng_scale, a[1] * lat_scale
    bx, by = b[0] * lng_scale, b[1] * lat_scale
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def main():
    raw = fetch_all_bridges()
    print(f"Fetched {len(raw)} raw bridge records from Gemeente Amsterdam open data")

    features = [f for f in (to_point_feature(item) for item in raw) if f]
    print(f"{len(features)} fall inside the greater Amsterdam area")

    segments = load_canal_segments()
    print(f"Matching against {len(segments)} navigable canal segments from {CANALS_PATH}")

    kept = []
    for feature in features:
        lon, lat = feature["geometry"]["coordinates"]
        best = min(point_to_segment_m((lon, lat), a, b) for a, b in segments)
        if best <= MAX_DISTANCE_FROM_CANAL_M:
            kept.append(feature)
    print(f"Kept {len(kept)} bridges within {MAX_DISTANCE_FROM_CANAL_M} m of the navigable canal network")

    out = {
        "type": "FeatureCollection",
        "name": "Amsterdam bridges",
        "generated_note": (
            "Baked from Gemeente Amsterdam open data (civieleconstructies/brug) by "
            "tools/refresh_bridges.py. Coordinates converted from RD New (EPSG:28992) "
            f"to WGS84; filtered to bridges within {MAX_DISTANCE_FROM_CANAL_M} m of a "
            "navigable canal edge."
        ),
        "features": kept,
    }
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
