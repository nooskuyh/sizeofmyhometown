import geographiclib from 'geographiclib-geodesic';

const geodesic = geographiclib.Geodesic.WGS84;

export function distanceBetween(first, second) {
  return geodesic.Inverse(first[1], first[0], second[1], second[0]).s12;
}
