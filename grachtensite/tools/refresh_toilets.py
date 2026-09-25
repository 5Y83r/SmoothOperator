#!/usr/bin/env python3
"""Regenerate data/toilets.geojson from Gemeente Amsterdam's official
public-toilets open dataset.

Why this exists: the app used to fetch this live from an Overpass mirror on
every page load (via /api/toilets/nearby), which reliably timed out on this
app's hosting provider. Public toilet locations barely change, so this is
now a static file, refreshed by running this script occasionally.

The correct dataset endpoint is geojson_lnglat.php with THEMA=openbare_toiletten
(the KAARTLAAG=OPENBARE_TOILETTEN + THEMA=buurtvoorzieningen combination used
by the previous implementation 404s -- the theme id changed upstream).

Usage:
    python3 tools/refresh_toilets.py
"""
import json
import os
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(HERE, "..", "data", "toilets.geojson")

URL = "https://maps.amsterdam.nl/open_geodata/geojson_lnglat.php?KAARTLAAG=OPENBARE_TOILETTEN&THEMA=openbare_toiletten"
SOURCE_PAGE = "https://maps.amsterdam.nl/openbare_toiletten/?LANG=en"
USER_AGENT = "SmoothOperator/1.0 (student project data refresh)"

_DAY_ABBR = {"ma": "Mon", "di": "Tue", "wo": "Wed", "do": "Thu", "vr": "Fri", "za": "Sat", "zo": "Sun"}
_WEEKDAY_NL_EN = [
    ("maandag", "Monday"), ("dinsdag", "Tuesday"), ("woensdag", "Wednesday"),
    ("donderdag", "Thursday"), ("vrijdag", "Friday"), ("zaterdag", "Saturday"),
    ("zondag", "Sunday"),
]
_PHRASE_NL_EN = [
    ("tot en met", "through"), ("verplaatsing naar", "relocates to"),
    ("ondergronds", "underground"), ("bovengronds", "above ground"),
    ("tussen", "between"), ("per dag", "per day"), ("24 uur", "24 hours"),
    ("uur", "h"), ("van", ""),
]


def translate_days(value):
    value = (value or "").strip()
    if not value:
        return "Daily"
    tokens = [t.strip() for t in value.split("-")]
    if tokens and all(t.lower() in _DAY_ABBR for t in tokens if t):
        return "-".join(_DAY_ABBR[t.lower()] for t in tokens if t)
    return value


def translate_hours(value):
    value = (value or "").strip()
    if not value:
        return ""
    lowered = value.lower()
    for nl, en in _WEEKDAY_NL_EN:
        lowered = lowered.replace(nl, en)
    for nl, en in _PHRASE_NL_EN:
        lowered = lowered.replace(nl, en)
    return " ".join(lowered.split())


def translate_soort(value):
    lower = (value or "").strip().lower()
    if "krul" in lower:
        return "Amsterdammertje (street urinal)"
    if "rolstoel" in lower:
        return "Public toilet (wheelchair accessible)"
    return "Public toilet"


def main():
    req = Request(URL, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    features = []
    for feature in payload.get("features", []):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        props = feature.get("properties") or {}
        soort = props.get("Soort") or ""
        try:
            price = float(props.get("Prijs_per_gebruik"))
        except (TypeError, ValueError):
            price = None

        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "name": translate_soort(soort),
                "location": (props.get("Omschrijving") or "").strip(),
                "opening_hours": translate_hours(props.get("Openingstijden")),
                "days_open": translate_days(props.get("Dagen_geopend")),
                "price_eur": price,
                "wheelchair_accessible": "rolstoel" in soort.lower(),
                "source": "Gemeente Amsterdam – Openbare toiletten (open data)",
                "source_url": SOURCE_PAGE,
            },
        })

    out = {
        "type": "FeatureCollection",
        "name": "Amsterdam public toilets",
        "generated_note": "Baked from Gemeente Amsterdam open data (Openbare toiletten) by tools/refresh_toilets.py.",
        "features": features,
    }
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"Wrote {len(features)} toilets to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
