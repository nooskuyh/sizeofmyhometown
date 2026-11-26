import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { distanceBetween } from './measurements.js';
import { setupPen } from './pen.js';
import { initialPlaces, setupSearch } from './places.js';

const initialGroundScale = 19;
const styleUrl = 'https://tiles.openfreemap.org/styles/liberty';
const districtData = new URL('./seoul-districts.geojson', import.meta.url).href;
const panes = [];
let unit = 'metric';
let visiblePane = 0;
let syncingCameras = false;
let pen;
let activeTool = 'move';

function updateSketchTools() {
  const hasStrokes = pen.hasStrokes();
  document.querySelector('#pen-undo').disabled = !hasStrokes;
  document.querySelector('#pen-clear').disabled = !hasStrokes;
  document.querySelector('[data-mode="adjust"]').hidden = !hasStrokes;
  if (!hasStrokes && activeTool === 'adjust') selectTool('move');
  const minutes = pen.latestEstimate();
  const result = document.querySelector('#walk-estimate');
  result.hidden = minutes === undefined;
  if (result.hidden) {
    result.textContent = '';
  } else if (minutes < 1) {
    result.textContent = 'Under 1 min';
  } else {
    const total = Math.round(minutes);
    result.textContent = `About ${total} ${total === 1 ? 'min' : 'mins'}`;
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

function setupMap(pane) {
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
  map.getCanvas().setAttribute('aria-label', 'Use arrow keys to move and plus or minus to zoom.');
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  pane.scale = pane.element.querySelector('.ground-scale');

  map.on('style.load', () => {
    error.hidden = true;
    if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', '#fbfcfc');
    if (map.getLayer('water')) map.setPaintProperty('water', 'fill-color', '#bad9f5');
    addSeoulDistricts(map);
    syncScale(map);
  });
  map.on('error', ({ error: mapError }) => {
    if (!map.getSource('seoul-districts') && mapError) {
      showMapError('The basemap could not load. Refresh the page to try again.');
    }
  });
  map.on('move', () => syncScale(map));
  map.on('zoom', () => {
    if (!syncingCameras) pen?.setGroundScale(groundScale(map));
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
  if (pane.map) {
    const latitude = Math.min(85.05, Math.max(-85.05, place.center[1]));
    pane.map.jumpTo({ center: [place.center[0], latitude], zoom: zoomAtScale(groundScale(pane.map), latitude) });
  }
  updatePlaceLabel(pane, index);
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
  };
  panes.push(pane);
  setupMap(pane);
  setupSearch(element, (result) => selectPlace(pane, index, result));
  updatePlaceLabel(pane, index);
}

if (panes.every(({ map }) => map)) {
  pen = setupPen(panes, groundScale, updateSketchTools);
  document.querySelector('[data-mode="pen"]').disabled = false;
  document.querySelector('#pen-undo').addEventListener('click', pen.undo);
  document.querySelector('#pen-clear').addEventListener('click', pen.clear);
}

const toolButtons = document.querySelectorAll('[data-mode]');

function selectTool(tool) {
  activeTool = tool;
  pen?.setTool(tool);
  if (tool !== 'move') showPane(0);
  for (const toggle of toolButtons) {
    toggle.setAttribute('aria-pressed', String(toggle.dataset.mode === tool));
  }
}

for (const button of toolButtons) {
  button.addEventListener('click', () => selectTool(button.dataset.mode));
}

for (const button of document.querySelectorAll('[data-unit]')) {
  button.addEventListener('click', () => {
    unit = button.dataset.unit;
    for (const toggle of document.querySelectorAll('[data-unit]')) {
      toggle.setAttribute('aria-pressed', String(toggle === button));
    }
    const active = panes[visiblePane].map ?? panes.find(({ map }) => map)?.map;
    if (active) updateScaleBars(active);
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
