/**
 * Distance helpers and a ZIP resolver built from the store data we already
 * fetch, so picking a store needs no third-party geocoder.
 */

export interface Point {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_MILES = 3958.8;

export function milesBetween(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const h =
    0.5 -
    Math.cos((b.lat - a.lat) * rad) / 2 +
    (Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * (1 - Math.cos((b.lng - a.lng) * rad))) / 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

export function normalizeZip(raw: string): string | null {
  const digits = raw.trim().replace(/[^0-9]/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

export interface ZipAnchor {
  zip: string;
  point: Point;
}

export interface ZipMatch {
  point: Point;
  /** 'exact' when a store sits in that ZIP; 'approximate' when only the
   *  three-digit prefix matched and the point is the centroid of those stores. */
  precision: 'exact' | 'approximate';
}

/**
 * Resolves a ZIP to a point using known store locations as the reference set.
 * Falls back to the centroid of every store sharing the three-digit prefix,
 * which is a coarse but explainable approximation — and it is reported as
 * approximate rather than passed off as a real geocode.
 */
export function resolveZip(zip: string, anchors: ZipAnchor[]): ZipMatch | null {
  const exact = anchors.filter((a) => a.zip === zip);
  if (exact.length > 0) return { point: centroid(exact.map((a) => a.point)), precision: 'exact' };

  const prefix = zip.slice(0, 3);
  const near = anchors.filter((a) => a.zip.startsWith(prefix));
  if (near.length > 0) return { point: centroid(near.map((a) => a.point)), precision: 'approximate' };

  return null;
}

function centroid(points: Point[]): Point {
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return { lat, lng };
}
