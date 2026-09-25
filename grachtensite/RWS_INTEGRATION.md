# Rijkswaterstaat / NtS integration

SmoothOperator now has a local obstruction model and REST API for live nautical restrictions.

## Data source

Rijkswaterstaat publishes Dutch shipping notices through Vaarweginformatie.nl / Fairway Information Services (FIS). The notices use the European Notices to Skippers (NtS) standard. FTM messages cover fairway and traffic restrictions such as closures, works and obstructions.

Official source: https://www.vaarweginformatie.nl/frp/nts/map

## Local API

Run `python server_api.py` from this directory.

- `GET /api/obstructions` - active obstructions only
- `GET /api/obstructions/all` - all locally stored records
- `POST /api/obstructions` - create a local obstruction
- `PUT /api/obstructions/{id}` - update one
- `DELETE /api/obstructions/{id}` - remove one

The live map entry point is `index_live.html`.

## RWS feed endpoint

Rijkswaterstaat publishes a public-interface specification for Vaarweginformatie/NtS. Because the website's browser map can change its internal endpoints, SmoothOperator deliberately does not hard-code an undocumented browser endpoint. Set the machine-readable public NtS endpoint supplied by Rijkswaterstaat as `RWS_NTS_URL` in the deployment environment, then use that URL from a sync job to populate `data/obstructions.json`.

The normalized record format is:

```json
{
  "id": "rws:...",
  "type": "canal_closure",
  "name": "...",
  "reason": "...",
  "description": "...",
  "valid_from": "...",
  "valid_until": "...",
  "closed": true,
  "waterway": "...",
  "location": "...",
  "geometry": {"type": "Point", "coordinates": [4.90, 52.37]},
  "source": "Rijkswaterstaat NtS"
}
```

If an upstream notice has geometry, the routing overlay uses it. Point notices use `radius_m` (default 35 m); line/polygon notices are treated as blocked when they intersect or come close to a canal graph edge.

## Routing behavior

The client marks affected canal graph edges as blocked and the existing Dijkstra routing function skips those edges. The underlying Amsterdam canal GeoJSON is not modified.

Obstructions are refreshed every five minutes while the live map is open. Validity dates are evaluated server-side, so expired notices stop affecting routing automatically.
