#!/usr/bin/env python3
"""
Filter canals GeoJSON based on bounding box coordinates.
Extracts canals within the specified Amsterdam area.
"""

import json
import sys
from shapely.geometry import shape, box
from shapely.ops import unary_union

def filter_canals_by_bbox(input_file, output_file, bbox):
    """
    Filter canals within the specified bounding box.
    
    Args:
        input_file (str): Path to input GeoJSON file
        output_file (str): Path to output filtered GeoJSON file
        bbox (tuple): Bounding box as (min_lng, min_lat, max_lng, max_lat)
    """
    
    # Create bounding box polygon
    min_lng, min_lat, max_lng, max_lat = bbox
    bbox_polygon = box(min_lng, min_lat, max_lng, max_lat)
    
    print(f"Filtering canals within bounding box: {bbox}")
    print(f"Bounding box coordinates: {min_lng}, {min_lat}, {max_lng}, {max_lat}")
    
    try:
        # Load the input GeoJSON file
        print(f"Loading {input_file}...")
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        print(f"Original features: {len(data['features'])}")
        
        # Filter features that intersect with the bounding box
        filtered_features = []
        for feature in data['features']:
            try:
                # Create geometry from feature
                geom = shape(feature['geometry'])
                
                # Check if geometry intersects with bounding box
                if geom.intersects(bbox_polygon):
                    filtered_features.append(feature)
                    
            except Exception as e:
                print(f"Warning: Could not process feature {feature.get('properties', {}).get('name', 'unknown')}: {e}")
                continue
        
        # Create output data structure
        output_data = {
            "type": "FeatureCollection",
            "name": "Amsterdam Canals",
            "crs": data.get("crs", {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}),
            "features": filtered_features
        }
        
        # Save filtered data
        print(f"Saving filtered data to {output_file}...")
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)
        
        print(f"Successfully filtered {len(filtered_features)} features out of {len(data['features'])}")
        print(f"Filtered data saved to {output_file}")
        
        # Print some statistics
        canal_names = set()
        for feature in filtered_features:
            name = feature.get('properties', {}).get('name')
            if name:
                canal_names.add(name)
        
        print(f"Unique canal names found: {len(canal_names)}")
        if canal_names:
            print("Sample canal names:", list(canal_names)[:10])
        
    except FileNotFoundError:
        print(f"Error: Input file {input_file} not found!")
        sys.exit(1)
    except Exception as e:
        print(f"Error processing file: {e}")
        sys.exit(1)

def main():
    # Define bounding box for Amsterdam canals
    # Format: (min_lng, min_lat, max_lng, max_lat)
    bbox = (4.847717, 52.338695, 4.967880, 52.413938)
    
    # File paths
    input_file = "data/routes.geojson"
    output_file = "data/Amsterdamcanals.geojson"
    
    print("Amsterdam Canals Filter")
    print("=" * 30)
    
    # Filter the canals
    filter_canals_by_bbox(input_file, output_file, bbox)
    
    print("\nFiltering complete!")

if __name__ == "__main__":
    main() 