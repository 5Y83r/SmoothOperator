import json

GEOJSON_PATH = 'data/Amsterdamcanals.geojson'

with open(GEOJSON_PATH, 'r', encoding='utf-8') as f:
    data = json.load(f)

count = 0
for feature in data.get('features', []):
    props = feature.get('properties', {})
    if props.get('name') == 'Amstel':
        props['speed_kmh'] = 7.5
        count += 1

with open(GEOJSON_PATH, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"Updated speed_kmh to 7.5 for {count} 'Amstel' features.") 