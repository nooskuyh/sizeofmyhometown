import geographiclib from 'geographiclib-geodesic';

const geodesic = geographiclib.Geodesic.WGS84;
const mask = geographiclib.Geodesic;
const metersPerMile = 1609.344;
const number = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 });

export function distanceBetween(first, second) {
  return geodesic.Inverse(first[1], first[0], second[1], second[0]).s12;
}

function longitudeNear(longitude, reference) {
  return longitude + 360 * Math.round((reference - longitude) / 360);
}

export function traceEdges(points) {
  if (!points.length) return [];

  const trace = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const [longitude, latitude] = points[index - 1];
    const [endLongitude, endLatitude] = points[index];
    const edge = geodesic.InverseLine(latitude, longitude, endLatitude, endLongitude);
    const segments = Math.min(512, Math.max(1, Math.ceil(edge.s13 / 40000)));
    for (let step = 1; step <= segments; step += 1) {
      const position = edge.Position(edge.s13 * step / segments, mask.STANDARD | mask.LONG_UNROLL);
      trace.push([longitudeNear(position.lon2, trace.at(-1)[0]), position.lat2]);
    }
  }
  return trace;
}

export function formatMeasurement(value, unit) {
  const divisor = unit === 'metric' ? 1000 : metersPerMile;
  const symbol = unit === 'metric' ? 'km' : 'mi';
  return `${number.format(value / divisor)} ${symbol}`;
}

export function comparisonText(first, second, places) {
  const ratio = second / first;
  const [reference, target] = places.map((place) => place.name);
  if (Math.abs(ratio - 1) < 0.005) return 'The distances are about the same.';
  return `${target} spans ${number.format(ratio)}× the distance measured in ${reference}.`;
}
