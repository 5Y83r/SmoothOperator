#!/usr/bin/env python3
"""
Create a routing graph from Amsterdam canals data.
Builds a network graph for pathfinding between docking locations.
"""

import json
import sys
import math
from shapely.geometry import Point, LineString
from shapely.ops import nearest_points
import networkx as nx
from collections import defaultdict

def load_geojson_data(file_path):
    """Load GeoJSON data from file."""
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def find_nearest_point_on_canal(point_coords, canal_geometry):
    """
    Find the nearest point on a canal to a given point.
    
    Args:
        point_coords: (lng, lat) coordinates of the point
        canal_geometry: Canal geometry from GeoJSON
    
    Returns:
        (lng, lat) coordinates of nearest point on canal
    """
    point = Point(point_coords)
    
    if canal_geometry['type'] == 'MultiLineString':
        min_distance = float('inf')
        nearest_point = None
        
        for line_coords in canal_geometry['coordinates']:
            line = LineString(line_coords)
            nearest = nearest_points(point, line)[1]
            distance = point.distance(nearest)
            
            if distance < min_distance:
                min_distance = distance
                nearest_point = (nearest.x, nearest.y)
        
        return nearest_point
    else:
        line = LineString(canal_geometry['coordinates'])
        nearest = nearest_points(point, line)[1]
        return (nearest.x, nearest.y)

def create_canal_graph(canals_data):
    """
    Create a graph from canal data.
    
    Args:
        canals_data: GeoJSON data of canals
    
    Returns:
        NetworkX graph and canal segments info
    """
    G = nx.Graph()
    canal_segments = {}
    
    for feature in canals_data['features']:
        properties = feature['properties']
        geometry = feature['geometry']
        
        if geometry['type'] == 'MultiLineString':
            for i, line_coords in enumerate(geometry['coordinates']):
                # Create unique ID for this segment
                segment_id = f"{properties.get('osm_id', 'unknown')}_{i}"
                
                # Calculate segment length and speed
                line = LineString(line_coords)
                length_km = line.length * 111  # Approximate km conversion
                speed_kmh = properties.get('speed_kmh', 6.0)
                time_hours = length_km / speed_kmh
                
                # Add nodes and edges to graph
                for j in range(len(line_coords) - 1):
                    node1 = (line_coords[j][0], line_coords[j][1])
                    node2 = (line_coords[j+1][0], line_coords[j+1][1])
                    
                    # Calculate segment time
                    segment_length = math.sqrt((node2[0] - node1[0])**2 + (node2[1] - node1[1])**2) * 111
                    segment_time = segment_length / speed_kmh
                    
                    G.add_edge(node1, node2, 
                              weight=segment_time,
                              length=segment_length,
                              speed=speed_kmh,
                              segment_id=segment_id,
                              canal_name=properties.get('name', 'Unknown Canal'))
                
                # Store segment info
                canal_segments[segment_id] = {
                    'coordinates': line_coords,
                    'properties': properties,
                    'length_km': length_km,
                    'time_hours': time_hours
                }
    
    return G, canal_segments

def find_nearest_canal_nodes(docking_points, canal_graph):
    """
    Find the nearest canal nodes to each docking point.
    
    Args:
        docking_points: List of docking point coordinates
        canal_graph: NetworkX graph of canals
    
    Returns:
        Dictionary mapping docking points to nearest canal nodes
    """
    nearest_nodes = {}
    
    for dock_coords in docking_points:
        dock_point = Point(dock_coords)
        min_distance = float('inf')
        nearest_node = None
        
        for node in canal_graph.nodes():
            node_point = Point(node)
            distance = dock_point.distance(node_point)
            
            if distance < min_distance:
                min_distance = distance
                nearest_node = node
        
        nearest_nodes[dock_coords] = nearest_node
    
    return nearest_nodes

def find_route(start_coords, end_coords, canal_graph, nearest_nodes):
    """
    Find the shortest route between two points using canal network.
    
    Args:
        start_coords: Starting point coordinates
        end_coords: Ending point coordinates
        canal_graph: NetworkX graph of canals
        nearest_nodes: Dictionary of nearest canal nodes
    
    Returns:
        Route information including path, distance, and time
    """
    start_node = nearest_nodes.get(start_coords)
    end_node = nearest_nodes.get(end_coords)
    
    if not start_node or not end_node:
        return None
    
    try:
        # Find shortest path
        path = nx.shortest_path(canal_graph, start_node, end_node, weight='weight')
        
        # Calculate total time and distance
        total_time = 0
        total_distance = 0
        route_segments = []
        
        for i in range(len(path) - 1):
            edge_data = canal_graph[path[i]][path[i+1]]
            total_time += edge_data['weight']
            total_distance += edge_data['length']
            
            route_segments.append({
                'from': path[i],
                'to': path[i+1],
                'time': edge_data['weight'],
                'distance': edge_data['length'],
                'speed': edge_data['speed'],
                'canal_name': edge_data['canal_name']
            })
        
        return {
            'path': path,
            'total_time_hours': total_time,
            'total_distance_km': total_distance,
            'segments': route_segments,
            'start_node': start_node,
            'end_node': end_node
        }
    
    except nx.NetworkXNoPath:
        return None

def create_routing_data():
    """Create routing data and save to JSON file."""
    
    print("Loading canal data...")
    canals_data = load_geojson_data('data/Amsterdamcanals.geojson')
    
    print("Loading docking locations...")
    docking_data = load_geojson_data('data/rondvaartopenafstapplekken.geojson')
    
    print("Creating canal graph...")
    canal_graph, canal_segments = create_canal_graph(canals_data)
    
    print(f"Graph created with {len(canal_graph.nodes())} nodes and {len(canal_graph.edges())} edges")
    
    # Extract docking point coordinates
    docking_points = []
    docking_info = {}
    
    for feature in docking_data['features']:
        coords = feature['geometry']['coordinates']
        coords_tuple = tuple(coords)  # Convert to tuple for hashing
        docking_points.append(coords)
        docking_info[coords_tuple] = {
            'name': feature['properties']['Name'],
            'description': feature['properties'].get('description', '')
        }
    
    print(f"Found {len(docking_points)} docking locations")
    
    # Find nearest canal nodes for each docking point
    print("Finding nearest canal nodes...")
    nearest_nodes = find_nearest_canal_nodes(docking_points, canal_graph)
    
    # Create routing data structure
    routing_data = {
        'canal_graph_nodes': list(canal_graph.nodes()),
        'canal_graph_edges': list(canal_graph.edges(data=True)),
        'docking_points': docking_points,
        'docking_info': {str(k): v for k, v in docking_info.items()},
        'nearest_nodes': {str(k): v for k, v in nearest_nodes.items()},
        'canal_segments': canal_segments
    }
    
    # Save routing data
    print("Saving routing data...")
    with open('data/routing_data.json', 'w', encoding='utf-8') as f:
        json.dump(routing_data, f, indent=2, ensure_ascii=False)
    
    print("Routing data saved to data/routing_data.json")
    
    # Test a few routes
    print("\nTesting routes between some docking locations...")
    test_routes = []
    
    for i in range(min(5, len(docking_points))):
        for j in range(i+1, min(i+3, len(docking_points))):
            start = docking_points[i]
            end = docking_points[j]
            
            route = find_route(start, end, canal_graph, nearest_nodes)
            if route:
                start_tuple = tuple(start)
                end_tuple = tuple(end)
                test_routes.append({
                    'start': docking_info[start_tuple]['name'],
                    'end': docking_info[end_tuple]['name'],
                    'time_hours': route['total_time_hours'],
                    'distance_km': route['total_distance_km']
                })
    
    print("Sample routes:")
    for route in test_routes[:3]:
        print(f"  {route['start']} → {route['end']}: {route['time_hours']:.2f}h ({route['distance_km']:.2f}km)")

if __name__ == "__main__":
    create_routing_data() 