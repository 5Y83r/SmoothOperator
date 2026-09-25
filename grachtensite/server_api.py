#!/usr/bin/env python3
"""Run SmoothOperator with local and live map data APIs.

Bridges and public toilets used to be fetched live from Overpass on every
request (see git history). That endpoint reliably timed out from this app's
hosting provider, which made both layers permanently broken in production.
They are now static files (data/bridges.geojson, data/toilets.geojson) baked
from official Gemeente Amsterdam open data by tools/fetch_bridges.py and
tools/build_toilets.py, served like any other file below by
SimpleHTTPRequestHandler. Only obstructions genuinely need a live call, since
closures change day to day.
"""

import http.server
import json
import os
import socketserver
from urllib.parse import urlparse

from obstructions import active_obstructions, delete_obstruction, load_obstructions, upsert_obstruction
from live_rws_feed import fetch_live_notices

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("PORT", "8000"))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            raise ValueError("Request body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        try:
            if path == "/api/obstructions":
                items = active_obstructions()
                self.json(200, {"obstructions": items, "count": len(items)})
                return
            if path == "/api/obstructions/all":
                items = load_obstructions()
                self.json(200, {"obstructions": items, "count": len(items)})
                return
            if path == "/api/obstructions/live":
                self.json(200, fetch_live_notices())
                return
            super().do_GET()
        except Exception as exc:
            self.json(502, {"error": str(exc)})

    def do_POST(self):
        if urlparse(self.path).path.rstrip("/") == "/api/obstructions":
            try:
                self.json(201, upsert_obstruction(self.body()))
            except (ValueError, TypeError) as exc:
                self.json(400, {"error": str(exc)})
            return
        self.json(404, {"error": "Not found"})

    def do_PUT(self):
        path = urlparse(self.path).path.rstrip("/")
        prefix = "/api/obstructions/"
        if path.startswith(prefix) and path != prefix:
            try:
                self.json(200, upsert_obstruction(self.body(), path[len(prefix):]))
            except (ValueError, TypeError) as exc:
                self.json(400, {"error": str(exc)})
            return
        self.json(404, {"error": "Not found"})

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip("/")
        prefix = "/api/obstructions/"
        if path.startswith(prefix) and path != prefix:
            oid = path[len(prefix):]
            if delete_obstruction(oid):
                self.json(200, {"deleted": True, "id": oid})
            else:
                self.json(404, {"error": "Obstruction not found"})
            return
        self.json(404, {"error": "Not found"})


if __name__ == "__main__":
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        print(f"SmoothOperator running at http://localhost:{PORT}")
        print(f"Obstruction API: http://localhost:{PORT}/api/obstructions")
        print(f"Live notices: http://localhost:{PORT}/api/obstructions/live")
        print(f"Bridges (static): http://localhost:{PORT}/data/bridges.geojson")
        print(f"Toilets (static): http://localhost:{PORT}/data/toilets.geojson")
        httpd.serve_forever()
