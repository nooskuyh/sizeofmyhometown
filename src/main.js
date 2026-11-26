import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { comparisonText, distanceBetween, formatMeasurement, traceEdges } from './measurements.js';
import { setupPen } from './pen.js';
import { initialPlaces, setupSearch } from './places.js';

const initialGroundScale = 19;
const styleUrl = 'https://tiles.openfreemap.org/styles/liberty';
const districtData = new URL('./seoul-districts.geojson', import.meta.url).href;
const mapColors = ['#00776a', '#815025'];
const panes = [];
let tool = 'distance';
let unit = 'metric';
let visiblePane = 0;
let syncingCameras = false;
let pen;

function updateComparison() {
  const values = panes.map(({ points }) => points.length === 2 ? distanceBetween(...points) : null);
  for (const [index, pane] of panes.entries()) {
    document.querySelector(`#name-${index}`).textContent = pane.place.name;
    document.querySelector(`#value-${index}`).textContent =
      values[index] === null ? '—' : formatMeasurement(values[index], unit);
  }
  const ratio = document.querySelector('#ratio');
  ratio.hidden = values.includes(null);
  ratio.textContent = ratio.hidden ? '' : comparisonText(...values, panes.map(({ place }) => place));
}

function feature(type, coordinates) {
  return { type: 'Feature', geometry: { type, coordinates }, properties: {} };
}

function updatePaneTools(pane) {
  const measuring = tool === 'distance';
  const count = pane.points.length;
  const prompts = ['Choose a start point on the map.', 'Choose an end point.', ''];
  pane.status.textContent = prompts[count];
  pane.undo.disabled = pane.clear.disabled = !count;

  if (pane.map) {
    const keyboardHelp = 'Use arrow keys to move and plus or minus to zoom.';
    let canvasHelp = keyboardHelp;
    if (measuring) canvasHelp += ' Press Enter to add a point at the map center.';
    if (tool === 'pen' && pane === panes[0]) canvasHelp = `Drag to draw. ${keyboardHelp}`;
    pane.map.getCanvas().setAttribute('aria-label', canvasHelp);
    pane.map.getCanvasContainer().classList.toggle('can-draw', measuring && count < 2);
  }
}

function updateDrawing(pane) {
  const { points } = pane;
  const source = pane.map?.getSource('measurement');
  if (source) {
    const features = points.map((point) => feature('Point', point));
    if (points.length === 2) features.unshift(feature('LineString', traceEdges(points)));
    source.setData({ type: 'FeatureCollection', features });
  }

  updatePaneTools(pane);
  pane.element.querySelector('.search-note').hidden = !points.length;
}

function addPoint(pane, location) {
  if (tool !== 'distance' || pane.points.length === 2) return;

  const point = location.wrap().toArray();
  if (pane.points.some((selected) => distanceBetween(selected, point) < 0.01)) {
    pane.status.textContent = 'Choose a different point.';
    return;
  }
  pane.points.push(point);
  updateDrawing(pane);
  updateComparison();
}

function updateSketchTools() {
  const hasStrokes = pen.hasStrokes();
  document.querySelector('#pen-undo').disabled = !hasStrokes;
  document.querySelector('#pen-clear').disabled = !hasStrokes;
  const minutes = pen.latestEstimate();
  const result = document.querySelector('#walk-estimate');
  result.hidden = minutes === undefined;
  if (result.hidden) {
    result.textContent = '';
  } else if (minutes < 1) {
    result.textContent = 'Less than 1 min to walk straight across';
  } else {
    const total = Math.round(minutes);
    const hours = Math.floor(total / 60);
    const remaining = total % 60;
    const duration = hours ? `${hours} hr${remaining ? ` ${remaining} min` : ''}` : `${total} min`;
    result.textContent = `About ${duration} to walk straight across`;
  }
}

function mercatorUnitsPerMeter(latitude) {
  return maplibregl.MercatorCoordinate.fromLngLat([0, latitude]).meterInMercatorCoordinateUnits();
}

function groundScale(map) {
  return 1 / (512 * 2 ** map.getZoom() * mercatorUnitsPerMeter(map.getCenter().lat));
}

function zoomAtScale(scale, latitude) {
  return Math.log2(1 / (scale * 512 * mercatorUnitsPerMeter(latitude)));
}

function updateScaleBars(active) {
  const metersPerPixel = groundScale(active);
  const metric = unit === 'metric';
  const metersPerUnit = metric ? 1 : 0.3048;
  const max = 105 * metersPerPixel / metersPerUnit;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [5, 2, 1].find((candidate) => candidate * magnitude <= max);
  const length = step * magnitude;
  const meters = length * metersPerUnit;
  const majorUnit = metric ? 1000 : 5280;
  const label = length >= majorUnit
    ? `${Number((length / majorUnit).toPrecision(3))} ${metric ? 'km' : 'mi'}`
    : `${Number(length.toPrecision(3))} ${metric ? 'm' : 'ft'}`;

  for (const pane of panes) {
    if (!pane.map) continue;
    pane.scale.hidden = false;
    pane.scale.textContent = label;
    pane.scale.style.width = `${meters / metersPerPixel}px`;
  }
}

function syncScale(active) {
  if (syncingCameras) return;
  if (panes.length < 2 || panes.some(({ map }) => !map)) {
    updateScaleBars(active);
    return;
  }
  const other = panes.find(({ map }) => map !== active).map;
  const latitude = other.getCenter().lat;
  const targetZoom = zoomAtScale(groundScale(active), latitude);
  const zoom = Math.max(other.getMinZoom(), Math.min(other.getMaxZoom(), targetZoom));
  syncingCameras = true;
  try {
    if (Math.abs(zoom - other.getZoom()) > 0.00001) other.jumpTo({ zoom });
    if (zoom !== targetZoom) {
      const matchedZoom = zoomAtScale(groundScale(other), active.getCenter().lat);
      if (Math.abs(matchedZoom - active.getZoom()) > 0.00001) active.jumpTo({ zoom: matchedZoom });
    }
  } finally {
    syncingCameras = false;
  }
  updateScaleBars(active);
}

function addMeasurementLayers(pane, color) {
  pane.map.addSource('measurement', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  pane.map.addLayer({
    id: 'measurement-outline', type: 'line', source: 'measurement',
    filter: ['==', '$type', 'LineString'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#fff', 'line-width': 6, 'line-opacity': 0.9 },
  });
  pane.map.addLayer({
    id: 'measurement-line', type: 'line', source: 'measurement',
    filter: ['==', '$type', 'LineString'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': 3.5 },
  });
  pane.map.addLayer({
    id: 'measurement-points', type: 'circle', source: 'measurement',
    filter: ['==', '$type', 'Point'],
    paint: { 'circle-color': color, 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  updateDrawing(pane);
}

function addSeoulDistricts(map) {
  const firstLabel = map.getStyle().layers.find(({ type }) => type === 'symbol')?.id;
  const attribution = '<a href="https://sgis.kostat.go.kr">Seoul districts · SGIS</a> · '
    + '<a href="https://github.com/vuski/admdongkor/blob/master/LICENSE-DATA">admdongkor (KOGL 1 / CC BY 4.0)</a>';
  map.addSource('seoul-districts', { type: 'geojson', data: districtData, attribution });
  map.addLayer({
    id: 'seoul-district-outline', type: 'line', source: 'seoul-districts', minzoom: 9.5,
    filter: ['!=', ['geometry-type'], 'Point'],
    paint: { 'line-color': '#674b78', 'line-width': 1.6, 'line-dasharray': [2, 1.6] },
  }, firstLabel);
  map.addLayer({
    id: 'seoul-district-name', type: 'symbol', source: 'seoul-districts', minzoom: 9.5,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9.5, 12, 13, 15],
      'text-padding': 4,
    },
    paint: { 'text-color': '#563764', 'text-halo-color': '#fffcf6', 'text-halo-width': 1.5 },
  });
}

function setupMap(pane, index) {
  const error = pane.element.querySelector('.map-error');
  const showMapError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  try {
    pane.map = new maplibregl.Map({
      container: pane.element.querySelector('.map-canvas'),
      style: styleUrl,
      center: pane.place.center,
      zoom: zoomAtScale(initialGroundScale, pane.place.center[1]),
      minZoom: 0,
      maxZoom: 22,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      doubleClickZoom: false,
    });
  } catch {
    showMapError('The map requires WebGL. Try a browser with hardware acceleration enabled.');
    return;
  }

  const map = pane.map;
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  pane.scale = pane.element.querySelector('.ground-scale');

  map.on('style.load', () => {
    error.hidden = true;
    if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', '#fbfcfc');
    if (map.getLayer('water')) map.setPaintProperty('water', 'fill-color', '#bad9f5');
    addSeoulDistricts(map);
    addMeasurementLayers(pane, mapColors[index]);
    syncScale(map);
  });
  map.on('error', ({ error: mapError }) => {
    if (!map.getSource('measurement') && mapError) {
      showMapError('The basemap could not load. Refresh the page to try again.');
    }
  });
  map.on('move', () => syncScale(map));
  map.on('zoom', () => {
    if (!syncingCameras) pen?.setGroundScale(groundScale(map));
  });
  map.on('click', ({ lngLat }) => addPoint(pane, lngLat));
  map.getCanvas().addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addPoint(pane, map.getCenter());
    }
  });
}

function updatePlaceLabel(pane, index) {
  pane.element.querySelector('.place-name').textContent = pane.place.name;
  pane.element.querySelector('.place-region').textContent = pane.place.region;
  pane.element.querySelector('.search-toggle').setAttribute('aria-label', `Change ${pane.place.name}`);
  pane.element.querySelector('.search-form').setAttribute('aria-label', `Find a replacement for ${pane.place.name}`);
  document.querySelector(`[data-visible-map="${index}"]`).textContent = pane.place.name;
}

function selectPlace(pane, index, place) {
  const { center, name } = pane.place;
  if (name === place.name && distanceBetween(center, place.center) < 100) return;

  pane.place = place;
  pane.points = [];
  if (pane.map) {
    const latitude = Math.min(85.05, Math.max(-85.05, place.center[1]));
    pane.map.jumpTo({ center: [place.center[0], latitude], zoom: zoomAtScale(groundScale(pane.map), latitude) });
  }
  updatePlaceLabel(pane, index);
  updateDrawing(pane);
  updateComparison();
}

for (const [index, place] of initialPlaces.entries()) {
  const element = document.querySelector('#map-pane-template').content.firstElementChild.cloneNode(true);
  element.id = `pane-${index}`;
  element.classList.add(index === 0 ? 'place-a' : 'place-b');
  element.classList.toggle('visible-map', index === visiblePane);
  element.querySelector('.place-role').textContent = index === 0 ? 'Familiar place' : 'Place to compare';
  document.querySelector('#maps').append(element);

  const pane = {
    element,
    place,
    points: [],
    status: element.querySelector('.measurement-status'),
    undo: element.querySelector('.undo'),
    clear: element.querySelector('.clear'),
  };
  panes.push(pane);
  setupMap(pane, index);
  setupSearch(element, (result) => selectPlace(pane, index, result));
  updatePlaceLabel(pane, index);
  updateDrawing(pane);

  pane.undo.addEventListener('click', () => {
    pane.points.pop();
    updateDrawing(pane);
    updateComparison();
  });
  pane.clear.addEventListener('click', () => {
    pane.points = [];
    updateDrawing(pane);
    updateComparison();
  });
}

if (panes.every(({ map }) => map)) {
  pen = setupPen(panes, groundScale, updateSketchTools);
  document.querySelector('[data-mode="pen"]').disabled = false;
  document.querySelector('#pen-undo').addEventListener('click', pen.undo);
  document.querySelector('#pen-clear').addEventListener('click', pen.clear);
}

const toolButtons = document.querySelectorAll('[data-mode]');
for (const button of toolButtons) {
  button.addEventListener('click', () => {
    tool = button.dataset.mode;
    pen?.setActive(tool === 'pen');
    document.querySelector('main').dataset.tool = tool;
    if (tool === 'pen') showPane(0);
    for (const toggle of toolButtons) {
      toggle.setAttribute('aria-pressed', String(toggle === button));
    }
    panes.forEach(updatePaneTools);
  });
}

for (const button of document.querySelectorAll('[data-unit]')) {
  button.addEventListener('click', () => {
    unit = button.dataset.unit;
    for (const toggle of document.querySelectorAll('[data-unit]')) {
      toggle.setAttribute('aria-pressed', String(toggle === button));
    }
    const active = panes[visiblePane].map ?? panes.find(({ map }) => map)?.map;
    if (active) updateScaleBars(active);
    updateComparison();
  });
}

function showPane(index) {
  if (visiblePane === index) return;
  visiblePane = index;
  for (const [paneIndex, pane] of panes.entries()) {
    pane.element.classList.toggle('visible-map', paneIndex === index);
  }
  for (const toggle of document.querySelectorAll('[data-visible-map]')) {
    toggle.setAttribute('aria-pressed', String(Number(toggle.dataset.visibleMap) === index));
  }
  panes[index].map?.resize();
}

for (const button of document.querySelectorAll('[data-visible-map]')) {
  button.addEventListener('click', () => showPane(Number(button.dataset.visibleMap)));
}

updateComparison();
