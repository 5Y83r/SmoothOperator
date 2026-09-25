#!/usr/bin/env python3
"""Live Rijkswaterstaat fairway-notice adapter for SmoothOperator.

The public GrachtAlert endpoint is synchronized from Rijkswaterstaat
Vaarweginformatie and exposes current/upcoming Amsterdam fairway notices.
This module deliberately keeps the upstream response flexible because the
public API can evolve without requiring the frontend to know its schema.
"""

from datetime import datetime, timezone
from urllib.request import Request, urlopen
import json

SOURCE_URL = "https://api.grachtalert.nl/functions/v1/api/v1/public/vaarweg-meldingen"
USER_AGENT = "SmoothOperator/1.0 live navigation"


def _first(obj, *keys):
    if not isinstance(obj, dict):
        return None
    for key in keys:
        value = obj.get(key)
        if value not in (None, ""):
            return value
    return None


def _geometry(item):
    geometry = _first(item, "geometry", "geojson", "shape")
    if isinstance(geometry, dict) and geometry.get("type"):
        return geometry
    lat = _first(item, "lat", "latitude", "breedtegraad")
    lng = _first(item, "lng", "lon", "longitude", "lengtegraad")
    if lat is not None and lng is not None:
        try:
            return {"type": "Point", "coordinates": [float(lng), float(lat)]}
        except (TypeError, ValueError):
            pass
    location = item.get("location") if isinstance(item, dict) else None
    # The live GrachtAlert feed wraps location as a LIST of one point
    # (e.g. "location": [{"lat": ..., "lon": ...}]), not a bare object -- the
    # isinstance(location, dict) check below used to silently reject that
    # shape, so every notice fell through to "no geometry" and never rendered
    # or blocked a route. Handle both shapes.
    candidates = location if isinstance(location, list) else [location]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        lat = _first(candidate, "lat", "latitude")
        lng = _first(candidate, "lng", "lon", "longitude")
        if lat is not None and lng is not None:
            try:
                return {"type": "Point", "coordinates": [float(lng), float(lat)]}
            except (TypeError, ValueError):
                continue
    return None


def normalize_notice(item, index):
    if not isinstance(item, dict):
        return None
    return {
        "id": str(_first(item, "id", "uuid", "meldingId") or f"rws-{index}"),
        "title": _first(item, "title", "titel", "naam", "onderwerp") or "Fairway notice",
        "description": _first(item, "description", "omschrijving", "tekst", "bericht") or "",
        "type": _first(item, "type", "meldingType", "berichtType", "categorie") or "unknown",
        "valid_from": _first(item, "valid_from", "validFrom", "start", "startdatum", "geldigVanaf", "begindatum"),
        "valid_until": _first(item, "valid_until", "validUntil", "end", "einddatum", "geldigTot", "einddatum"),
        "waterway": _first(item, "waterway", "vaarweg", "vaarwegNaam", "objectNaam") or "",
        "location": _first(item, "location", "locatie", "plaats", "locatieOmschrijving") or "",
        "geometry": _geometry(item),
        "source": "Rijkswaterstaat Vaarweginformatie (via live synchronization)",
        "source_url": SOURCE_URL,
        "raw": item,
    }


def fetch_live_notices(timeout=15):
    request = Request(SOURCE_URL, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("data") or payload.get("meldingen") or payload.get("vaarwegMeldingen") or payload.get("items") or []
    else:
        items = []

    notices = [normalize_notice(item, i) for i, item in enumerate(items)]
    notices = [n for n in notices if n]
    return {
        "source": "Rijkswaterstaat Vaarweginformatie",
        "via": "GrachtAlert public synchronization",
        "source_url": SOURCE_URL,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "count": len(notices),
        "notices": notices,
    }
