#!/usr/bin/env python3
"""Obstruction storage and integration helpers for SmoothOperator.

The application stores normalized obstructions locally so routing remains fast and
works even when the upstream nautical-information service is temporarily offline.
RWS/NtS data can be synchronized through the server's /api/obstructions/sync endpoint.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "obstructions.json")
_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _ensure_file() -> None:
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    if not os.path.exists(DATA_FILE):
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "updated_at": _now_iso(), "obstructions": []}, f, indent=2)


def load_obstructions() -> list[dict[str, Any]]:
    _ensure_file()
    with _lock:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    return data.get("obstructions", [])


def save_obstructions(obstructions: list[dict[str, Any]]) -> None:
    _ensure_file()
    payload = {"version": 1, "updated_at": _now_iso(), "obstructions": obstructions}
    tmp = DATA_FILE + ".tmp"
    with _lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        os.replace(tmp, DATA_FILE)


def is_active(obstruction: dict[str, Any], at: datetime | None = None) -> bool:
    """Return whether an obstruction is active at a given UTC time."""
    if obstruction.get("closed") is False:
        return False
    at = at or datetime.now(timezone.utc)

    def parse(value: Any) -> datetime | None:
        if not value:
            return None
        text = str(value).replace("Z", "+00:00")
        try:
            result = datetime.fromisoformat(text)
            return result if result.tzinfo else result.replace(tzinfo=timezone.utc)
        except ValueError:
            return None

    start = parse(obstruction.get("valid_from"))
    end = parse(obstruction.get("valid_until"))
    if start and at < start:
        return False
    if end and at > end:
        return False
    return True


def active_obstructions(at: datetime | None = None) -> list[dict[str, Any]]:
    return [o for o in load_obstructions() if is_active(o, at)]


def upsert_obstruction(obstruction: dict[str, Any], obstruction_id: str | None = None) -> dict[str, Any]:
    items = load_obstructions()
    oid = obstruction_id or obstruction.get("id") or str(uuid.uuid4())
    item = dict(obstruction)
    item["id"] = oid
    item.setdefault("closed", True)
    item.setdefault("type", "canal_closure")
    item.setdefault("source", "local")
    item["updated_at"] = _now_iso()

    replaced = False
    for i, existing in enumerate(items):
        if existing.get("id") == oid:
            items[i] = item
            replaced = True
            break
    if not replaced:
        items.append(item)
    save_obstructions(items)
    return item


def delete_obstruction(obstruction_id: str) -> bool:
    items = load_obstructions()
    remaining = [o for o in items if o.get("id") != obstruction_id]
    if len(remaining) == len(items):
        return False
    save_obstructions(remaining)
    return True


def normalize_upstream_item(item: dict[str, Any]) -> dict[str, Any]:
    """Normalize common NtS/GeoJSON fields without changing the source text.

    The RWS public NtS interface is standardized, but deployments may expose
    XML or JSON wrappers. This adapter accepts the common field names and keeps
    the original message in `raw` for traceability.
    """
    props = item.get("properties", item)
    geometry = item.get("geometry") or props.get("geometry")
    oid = str(props.get("id") or props.get("internal_id") or props.get("message_id") or uuid.uuid4())
    title = props.get("title") or props.get("subject") or props.get("description") or "RWS nautical notice"
    reason = props.get("reason") or props.get("reason_code") or props.get("cause") or ""
    return {
        "id": f"rws:{oid}",
        "type": props.get("type") or "canal_closure",
        "name": props.get("name") or title,
        "reason": reason,
        "description": props.get("description") or props.get("text") or props.get("message") or "",
        "valid_from": props.get("valid_from") or props.get("from") or props.get("start"),
        "valid_until": props.get("valid_until") or props.get("to") or props.get("end"),
        "closed": props.get("closed", True),
        "waterway": props.get("waterway") or props.get("fairway_name"),
        "location": props.get("location") or props.get("object_name"),
        "geometry": geometry,
        "source": "Rijkswaterstaat NtS",
        "source_id": oid,
        "updated_at": _now_iso(),
        "raw": item,
    }


def normalize_upstream_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        if payload.get("features") and isinstance(payload["features"], list):
            return [normalize_upstream_item(x) for x in payload["features"]]
        for key in ("items", "messages", "notices", "obstructions"):
            if isinstance(payload.get(key), list):
                return [normalize_upstream_item(x) for x in payload[key]]
        return [normalize_upstream_item(payload)]
    if isinstance(payload, list):
        return [normalize_upstream_item(x) for x in payload]
    raise ValueError("Unsupported upstream payload")
