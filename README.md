SmootOperator - Map Website
A basic website for displaying maps using Leaflet and MapLibre GL JS, focused on Amsterdam's canal system.

Features
Interactive Map: Displays a map centered on Amsterdam
Canal Markers: Sample markers for major Amsterdam canals
Responsive Design: Works on desktop and mobile devices
Modern UI: Clean, modern interface with smooth styling
Getting Started
Open the website: Simply open index.html in your web browser
View the map: The map will load centered on Amsterdam with sample canal markers
Interact: Click on markers to see popup information
Map Libraries Used
Leaflet: Primary map library for basic map functionality
MapLibre GL JS: Alternative map library (ready for implementation)
File Structure
grachtensite/
├── index.html      # Main HTML file
├── styles.css      # CSS styling
├── script.js       # JavaScript functionality
└── README.md       # This file
Customization
Changing the Map Center
Edit the AMSTERDAM_COORDS constant in script.js:

const AMSTERDAM_COORDS = [52.3676, 4.9041]; // [latitude, longitude]
Adding New Markers
Use the utility function:

MapUtils.addCustomMarker(map, [lat, lng], "Popup content");
Switching to MapLibre
To use MapLibre instead of Leaflet, uncomment the MapLibre implementation in script.js and modify the HTML accordingly.

Dependencies
Leaflet 1.9.4 (via CDN)
MapLibre GL JS 3.6.2 (via CDN)
OpenStreetMap tiles
Browser Support
Works in all modern browsers that support ES6+ JavaScript.
