// Geodesy on the WGS84 ellipsoid for the status bar and the ruler.
//   distance   Vincenty's inverse formula (haversine on the authalic sphere if it doesn't converge)
//   greatCircle vertices along the great circle, so the line drawn is the line measured
//   ringArea   spherical excess on the authalic sphere with authalic latitudes (matches the ellipsoid)
// Points are [lng, lat] in degrees throughout.

const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const R_AUTH = 6371007.181; // radius of the sphere with the ellipsoid's surface area
const RAD = Math.PI / 180;

function haversine([lng1, lat1], [lng2, lat2]) {
  const p1 = lat1 * RAD; const p2 = lat2 * RAD;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lng2 - lng1) * RAD) / 2) ** 2;
  return 2 * R_AUTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Geodesic distance in metres between two [lng, lat] points (Vincenty inverse, WGS84). */
export function distance(p, q) {
  if (p[0] === q[0] && p[1] === q[1]) return 0;
  const L = (q[0] - p[0]) * RAD;
  const U1 = Math.atan((1 - F) * Math.tan(p[1] * RAD));
  const U2 = Math.atan((1 - F) * Math.tan(q[1] * RAD));
  const sinU1 = Math.sin(U1); const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2); const cosU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma; let cosSigma; let sigma; let cos2Alpha; let cos2SigmaM;
  let converged = false;
  for (let i = 0; i < 200; i++) {
    const sinL = Math.sin(lambda); const cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0; // coincident
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0; // equatorial line
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - prev) < 1e-12) { converged = true; break; }
  }
  if (!converged) return haversine(p, q); // nearly antipodal
  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
  const k1 = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const k2 = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma = k2 * sinSigma * (cos2SigmaM + (k2 / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2)
    - (k2 / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return B * k1 * (sigma - dSigma);
}

const toVec = ([lng, lat]) => {
  const l = lng * RAD; const p = lat * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const toLngLat = ([x, y, z]) => [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];

/** Points from p to q along the great circle, at most `stepM` apart and at most `maxVerts` in all. */
export function greatCircle(p, q, stepM = 20000, maxVerts = 256) {
  const a = toVec(p); const b = toVec(q);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const w = Math.acos(dot);
  const n = Math.min(maxVerts - 1, Math.max(1, Math.ceil((w * R_AUTH) / stepM)));
  if (w < 1e-12 || n === 1) return [p, q];
  const s = Math.sin(w);
  const out = [p];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const k1 = Math.sin((1 - t) * w) / s; const k2 = Math.sin(t * w) / s;
    out.push(toLngLat([k1 * a[0] + k2 * b[0], k1 * a[1] + k2 * b[1], k1 * a[2] + k2 * b[2]]));
  }
  out.push(q);
  return out;
}

/** Great-circle midpoint of p and q (label position for a segment). */
export function midpoint(p, q) {
  const a = toVec(p); const b = toVec(q);
  return toLngLat([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

/** A whole path densified along great circles (for drawing). */
export function densify(points, stepM = 20000) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const seg = greatCircle(points[i], points[i + 1], stepM);
    out.push(...(i ? seg.slice(1) : seg));
  }
  return points.length === 1 ? [points[0]] : out;
}

export const pathLength = (points) => {
  let s = 0;
  for (let i = 0; i + 1 < points.length; i++) s += distance(points[i], points[i + 1]);
  return s;
};

const q = (phi) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const QP = q(Math.PI / 2);

/** Area in m² of a closed ring of [lng, lat] (first point need not be repeated). */
export function ringArea(ring) {
  if (ring.length < 3) return 0;
  const closed = [...ring, ring[0]];
  const pts = [];
  for (let i = 0; i + 1 < closed.length; i++) pts.push(...greatCircle(closed[i], closed[i + 1], 5000, 100000).slice(0, -1));
  pts.push(pts[0]);
  let sum = 0;
  let sb0 = q(pts[0][1] * RAD) / QP;
  for (let i = 0; i + 1 < pts.length; i++) {
    const sb1 = q(pts[i + 1][1] * RAD) / QP;
    let dl = (pts[i + 1][0] - pts[i][0]) * RAD;
    if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI;
    sum += dl * (2 + sb0 + sb1);
    sb0 = sb1;
  }
  return (Math.abs(sum) * R_AUTH * R_AUTH) / 2;
}

/** Perimeter in metres of a closed ring. */
export const ringPerimeter = (ring) => pathLength([...ring, ring[0]]);

// ---- formats (Indian digit grouping) ---------------------------------------------------------------
const num = (v, d) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** 8.4 m · 850 m · 12.43 km · 1,235 km */
export function fmtLength(m) {
  if (!Number.isFinite(m)) return '–';
  if (m < 10) return `${num(m, 1)} m`;
  if (m < 1000) return `${num(Math.round(m), 0)} m`;
  const km = m / 1000;
  return `${num(km, km < 10 ? 3 : km < 100 ? 2 : 0)} km`;
}

/** 8,500 m² · 4.21 km² · 1,234 km² */
export function fmtArea(m2) {
  if (!Number.isFinite(m2)) return '–';
  if (m2 < 1e6) return `${num(Math.round(m2), 0)} m²`;
  const km2 = m2 / 1e6;
  return `${num(km2, km2 < 100 ? 2 : 0)} km²`;
}

/** 12.975372° N, 77.630956° E */
export const fmtDec = (lng, lat) => `${Math.abs(lat).toFixed(6)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lng).toFixed(6)}° ${lng < 0 ? 'W' : 'E'}`;

/** 12.975372, 77.630956 (lat, lng) for the clipboard */
export const plainLatLng = (lng, lat) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
