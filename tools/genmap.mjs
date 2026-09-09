// Build-time map generator.
// Natural Earth 50m country geometry -> projected, cut into procedural provinces
// by a weighted Lloyd-relaxed Voronoi partition. Province adjacency, coastlines
// and terrain are derived from a rasterised version of the finished map.
// Output: src/data/world.json

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as topojson from 'topojson-client';
import { geoMiller } from 'd3-geo-projection';
import { geoArea } from 'd3-geo';
import { Delaunay } from 'd3-delaunay';
import polyclip from 'polygon-clipping';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const MAP_W = 4096;             // projected map width, map units
const LAT_CLIP = [-58, 84];     // drop Antarctica, trim the stretched arctic
const TARGET_PROVINCES = 4200;
const AREA_EXP = 0.72;          // sub-linear: big empty nations don't eat the budget
const MIN_ISLAND_KM2 = 4000;    // smaller secondary islands are dropped
/** Set PROVINCES=voronoi to ignore real subdivisions entirely. */
const USE_ADMIN1 = (process.env.PROVINCES ?? 'admin1') !== 'voronoi';
const QUANT = 0.006;            // lon/lat quantisation, degrees (~660 m)
const RAST = 1;               // raster resolution, pixels per map unit
const GAP_CLOSE = 1;          // raster dilation passes when finding borders

const EARTH_KM2 = 510072000 / (4 * Math.PI); // km^2 per steradian

// ---------------------------------------------------------------- geometry --

const ringArea = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
};
const polyArea = (p) =>
  Math.abs(ringArea(p[0])) - p.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);

function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function pointInRing(px, py, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInPoly = (px, py, p) =>
  pointInRing(px, py, p[0]) && !p.slice(1).some((h) => pointInRing(px, py, h));

/**
 * Thin a ring by snapping to a fixed lon/lat lattice and dropping repeats.
 * Order-independent on purpose: two countries sharing a border arc must end up
 * with byte-identical vertices there, otherwise the shared edge - and with it
 * the frontline between them - cannot be recovered later.
 */
function quantizeRing(ring, grid) {
  const snap = (v) => Math.round(v / grid) * grid;
  const out = [];
  for (const [lon, lat] of ring) {
    const p = [snap(lon), snap(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length >= 2) {
    const [a, b] = [out[0], out[out.length - 1]];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  }
  return out.length >= 4 ? out : ring;
}

const round1 = (v) => Math.round(v * 10) / 10;
const round4 = (v) => Math.round(v * 1e4) / 1e4;   // ~11 m: enough to share edges
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII',
  'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV'];

// deterministic: every player generates the identical map
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x484f4934);

// ------------------------------------------------------------ load + project --

const topo = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/world-atlas/countries-50m.json'), 'utf8'));
const fc = topojson.feature(topo, topo.objects.countries);

const projection = geoMiller().translate([0, 0]).scale(1).precision(0.1);
const k = MAP_W / (2 * projection([180, 0])[0]);
const yTop = projection([0, LAT_CLIP[1]])[1] * k;
const yBot = projection([0, LAT_CLIP[0]])[1] * k;
const MAP_H = Math.round(yBot - yTop);
projection.scale(k).translate([MAP_W / 2, -yTop]);

const clampLat = (lat) => Math.max(LAT_CLIP[0] - 3, Math.min(LAT_CLIP[1] + 3, lat));
const project = ([lon, lat]) => projection([lon, clampLat(lat)]);
const unproject = (x, y) => projection.invert([x, y]) ?? [0, 0];

// province density weighting: how much map detail a region deserves
const REGION_W = [
  // lon0, lat0, lon1, lat1, weight
  [-11, 36, 42, 60, 3.2],    // Europe: the main theatre, so the densest map
  [-11, 60, 32, 71, 1.3],    // Scandinavia
  [128, 30, 146, 46, 2.0],   // Japan / Korea
  [105, 20, 124, 42, 1.5],   // eastern China
  [-90, 25, -66, 48, 1.3],   // US north-east
  [25, 30, 62, 42, 1.3],     // Near East
  [-17, 15, 34, 31, 0.45],   // Sahara
  [34, 15, 60, 32, 0.5],     // Arabian desert
  [118, -30, 141, -20, 0.5], // Australian interior
  [-72, -28, -62, -18, 0.6], // Atacama / altiplano
];
function weightAt(lon, lat) {
  const alat = Math.abs(lat);
  let w = alat > 68 ? 0.16 : alat > 60 ? 0.35 : alat > 54 ? 0.65 : 1;
  for (const [a, b, c, d, m] of REGION_W) if (lon >= a && lon <= c && lat >= b && lat <= d) w *= m;
  return w;
}

const SKIP = new Set(['Antarctica', 'Fr. S. Antarctic Lands', 'Heard I. and McDonald Is.']);

/**
 * Rings that cross the antimeridian arrive with a +179.9 -> -180.0 jump, which
 * in flat map space smears the polygon across the whole world. Unwrap the ring
 * into a continuous longitude run, then cut it back into [-180, 180] pieces.
 */
function unwrapRing(ring) {
  const out = [ring[0].slice()];
  let off = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] - ring[i - 1][0];
    if (d > 180) off -= 360; else if (d < -180) off += 360;
    out.push([ring[i][0] + off, ring[i][1]]);
  }
  return out;
}
const lonBox = (k) => [[
  [-180 + 360 * k, -90], [180 + 360 * k, -90],
  [180 + 360 * k, 90], [-180 + 360 * k, 90], [-180 + 360 * k, -90]]];

function splitAtAntimeridian(poly) {
  const un = poly.map(unwrapRing);
  let lo = Infinity, hi = -Infinity;
  for (const [lon] of un[0]) { if (lon < lo) lo = lon; if (lon > hi) hi = lon; }
  if (lo >= -180.001 && hi <= 180.001) return [poly];
  const pieces = [];
  for (let k = -1; k <= 1; k++) {
    if (hi < -180 + 360 * k || lo > 180 + 360 * k) continue;
    let clipped;
    try { clipped = polyclip.intersection([un], lonBox(k)); } catch { continue; }
    for (const p of clipped || []) {
      const shifted = p.map((r) => r.map(([lon, lat]) => [lon - 360 * k, lat]));
      if (Math.abs(polyArea(shifted)) > 1e-6) pieces.push(shifted);
    }
  }
  return pieces.length ? pieces : [poly];
}

/**
 * Real administrative subdivisions, where they exist.
 *
 * Natural Earth's admin-1 set covers essentially every country - German
 * Laender, French departements, Russian oblasts - so provinces can be real
 * places with real names instead of Voronoi cells. Countries it does not cover
 * fall back to the generated partition.
 */
const ADMIN1_FILE = path.join(root, 'vendor/ne_10m_admin_1.geojson');

/** Natural Earth spells some countries differently in the two datasets. */
const ADMIN_ALIAS = {
  'Dem. Rep. Congo': 'Democratic Republic of the Congo',
  'Congo': 'Republic of the Congo',
  'Tanzania': 'United Republic of Tanzania',
  'Central African Rep.': 'Central African Republic',
  "Côte d'Ivoire": 'Ivory Coast',
  'Czechia': 'Czech Republic',
  'Serbia': 'Republic of Serbia',
  'W. Sahara': 'Western Sahara',
  'Timor-Leste': 'East Timor',
  'eSwatini': 'Swaziland',
  'Guinea-Bissau': 'Guinea Bissau',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'North Macedonia': 'Macedonia',
  'Laos': 'Laos',
  'S. Sudan': 'S. Sudan',
  'Bahamas': 'The Bahamas',
  'Cabo Verde': 'Cape Verde',
  'Solomon Is.': 'Solomon Islands',
  'Eq. Guinea': 'Equatorial Guinea',
  'Dominican Rep.': 'Dominican Republic',
};

/**
 * Load the subdivisions as a *naming* layer.
 *
 * Their geometry is not usable as the province partition: Natural Earth's
 * admin-1 granularity swings from 16 German Laender to 345 British council
 * areas, which would give Slovenia more provinces than Germany, and thousands
 * of provinces too small to register in the adjacency raster. So the partition
 * stays Voronoi - even sizes, guaranteed coverage - and each cell simply takes
 * the name of the subdivision its centre falls in.
 */
function loadAdmin1() {
  if (!fs.existsSync(ADMIN1_FILE)) {
    console.warn('admin-1 file missing; provinces will use generated names');
    return { lookup: () => null, count: 0, countries: 0 };
  }
  const fc = JSON.parse(fs.readFileSync(ADMIN1_FILE, 'utf8'));
  const cells = new Map();          // "gx,gy" -> [{name, rings, bbox}]
  const GRID = 2;
  let count = 0;
  const countries = new Set();

  for (const f of fc.features) {
    const name = f.properties.name || f.properties.name_en;
    if (!name) continue;
    countries.add(f.properties.admin);
    const raw = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates]
      : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const poly of raw) {
      if (!poly[0] || poly[0].length < 4) continue;
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      for (const [x, y] of poly[0]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const entry = { name, admin: f.properties.admin, rings: poly, bbox: [x0, y0, x1, y1] };
      count++;
      for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++) {
        for (let gy = Math.floor(y0 / GRID); gy <= Math.floor(y1 / GRID); gy++) {
          const key = `${gx},${gy}`;
          const list = cells.get(key) ?? [];
          list.push(entry);
          cells.set(key, list);
        }
      }
    }
  }

  const inRing = (px, py, r) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j], b = r[i];
      if ((a[1] > py) !== (b[1] > py) && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };

  return {
    count,
    countries: countries.size,
    /**
     * The subdivision containing a point, or null. `country` restricts the
     * answer to that nation's own subdivisions, so a cell near the Alps cannot
     * come back named after somewhere across the border.
     */
    lookup(lon, lat, country) {
      const list = cells.get(`${Math.floor(lon / GRID)},${Math.floor(lat / GRID)}`);
      if (!list) return null;
      const wanted = country ? (ADMIN_ALIAS[country] ?? country) : null;
      for (const e of list) {
        if (wanted && e.admin !== wanted) continue;
        const [x0, y0, x1, y1] = e.bbox;
        if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
        if (inRing(lon, lat, e.rings[0]) && !e.rings.slice(1).some((h) => inRing(lon, lat, h))) return e.name;
      }
      return null;
    },
  };
}

const admin1 = USE_ADMIN1 ? loadAdmin1() : { lookup: () => null, count: 0, countries: 0 };
console.log(`admin-1: ${admin1.count} subdivision polygons across ${admin1.countries} countries (naming only)`);

const countries = [];
for (const f of fc.features) {
  const name = f.properties?.name;
  if (!name || SKIP.has(name) || !f.geometry) continue;
  const geom = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const raw = geom.flatMap(splitAtAntimeridian);
  const polys = [];
  for (const poly of raw) {
    const rings = [], geoRings = [];
    for (const ring of poly) {
      const q = quantizeRing(ring, QUANT);
      const pr = q.map(project);
      if (pr.length >= 4) { rings.push(pr); geoRings.push(q); }
    }
    if (!rings.length) continue;
    let sterad = geoArea({ type: 'Polygon', coordinates: geoRings });
    if (sterad > 2 * Math.PI) sterad = 4 * Math.PI - sterad;
    const km2 = sterad * EARTH_KM2;
    if (!isFinite(km2) || km2 <= 0) continue;
    // average habitability weight over the ring vertices
    let w = 0;
    for (const [lon, lat] of geoRings[0]) w += weightAt(lon, lat);
    w /= geoRings[0].length;
    polys.push({ rings, km2, weight: w, area: polyArea(rings) });
  }
  if (!polys.length) continue;
  polys.sort((a, b) => b.km2 - a.km2);

  countries.push({ name, polys });
}

// Province budget: each country gets provinces ~ (weighted area)^AREA_EXP, so a
// small dense nation still reads as a real theatre next to a continental one.
for (const c of countries) {
  // A country must be completely covered by its own territory. For real
  // subdivisions every one of them is land that has to appear; only genuinely
  // tiny offshore fragments are dropped, and never the largest piece.
  c.kept = c.polys.filter((p, i) => i === 0 || p.km2 >= MIN_ISLAND_KM2);
  c.weighted = c.kept.reduce((t, p) => t + p.km2 * p.weight, 0);
  c.score = Math.pow(c.weighted, AREA_EXP);
}
const K = TARGET_PROVINCES / countries.reduce((s, c) => s + c.score, 0);
for (const c of countries) {
  const n = Math.max(c.kept.length, Math.min(140, Math.round(K * c.score)));
  // hand out the country's provinces across its islands, largest remainder first
  const share = c.kept.map((p) => (p.km2 * p.weight * n) / c.weighted);
  const alloc = share.map((v) => Math.max(1, Math.floor(v)));
  let left = n - alloc.reduce((a, b) => a + b, 0);
  const order = share.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) alloc[order[i][1]]++;
  c.kept.forEach((p, i) => { p.n = alloc[i]; });
}

// ------------------------------------------------------------- subdivision --

function sampleInside(poly, n, bbox) {
  const [x0, y0, x1, y1] = bbox;
  const pts = [];
  let guard = 0;
  while (pts.length < n && guard++ < n * 500) {
    const x = x0 + rng() * (x1 - x0);
    const y = y0 + rng() * (y1 - y0);
    if (!pointInPoly(x, y, poly)) continue;
    // weighted rejection: sparse seeds where the map deserves less detail
    const [lon, lat] = unproject(x, y);
    if (rng() > Math.min(1, weightAt(lon, lat) / 1.2)) continue;
    pts.push([x, y]);
  }
  return pts;
}

function subdivide(poly, n) {
  if (n <= 1) return [[poly]];
  const bbox = bboxOf(poly[0]);
  let pts = sampleInside(poly, n, bbox);
  if (pts.length < 2) return [[poly]];

  for (let it = 0; it < 3; it++) {   // Lloyd relaxation -> even province sizes
    const d = Delaunay.from(pts);
    const v = d.voronoi([bbox[0] - 1, bbox[1] - 1, bbox[2] + 1, bbox[3] + 1]);
    pts = pts.map((p, i) => {
      const cell = v.cellPolygon(i);
      if (!cell) return p;
      let cx = 0, cy = 0;
      for (const [x, y] of cell) { cx += x; cy += y; }
      cx /= cell.length; cy /= cell.length;
      return pointInPoly(cx, cy, poly) ? [cx, cy] : p;
    });
  }

  const d = Delaunay.from(pts);
  const v = d.voronoi([bbox[0] - 1, bbox[1] - 1, bbox[2] + 1, bbox[3] + 1]);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const cell = v.cellPolygon(i);
    if (!cell) continue;
    let clipped;
    try { clipped = polyclip.intersection([poly], [cell]); } catch { continue; }
    const parts = (clipped || []).filter((p) => polyArea(p) > 0.2);
    if (parts.length) out.push(parts);
  }
  return out.length ? out : [[poly]];
}

const provinces = [];
for (let ci = 0; ci < countries.length; ci++) {
  const c = countries[ci];
  for (const p of c.kept) {
    for (const parts of subdivide(p.rings, p.n)) {
      const area = parts.reduce((s, q) => s + polyArea(q), 0);
      if (area < 0.5) continue;
      provinces.push({ country: ci, parts, area });
    }
  }
}

// ------------------------------------------------- rasterise for topology --

const RW = Math.ceil(MAP_W * RAST), RH = Math.ceil(MAP_H * RAST);
const grid = new Int32Array(RW * RH).fill(-1);

function fillPoly(poly, id) {
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const ring of poly)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0] * RAST, ay = ring[j][1] * RAST;
      const bx = ring[i][0] * RAST, by = ring[i][1] * RAST;
      if (ay === by) continue;
      edges.push([ax, ay, bx, by]);
      minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
    }
  const xs = [];
  for (let y = Math.max(0, Math.ceil(minY - 0.5)); y <= Math.min(RH - 1, Math.floor(maxY)); y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (const [ax, ay, bx, by] of edges)
      if ((ay > cy) !== (by > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i] - 0.5));
      const x1 = Math.min(RW - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = x0; x <= x1; x++) grid[y * RW + x] = id;
    }
  }
}
provinces.forEach((pv, id) => { for (const poly of pv.parts) fillPoly(poly, id); });

// coastline: a land pixel touching ocean or the map edge
const coastal = new Uint8Array(provinces.length);
const px = new Int32Array(provinces.length); // pixel counts, for sanity checks
for (let y = 0; y < RH; y++)
  for (let x = 0; x < RW; x++) {
    const id = grid[y * RW + x];
    if (id < 0) continue;
    px[id]++;
    if (x === 0 || y === 0 || x === RW - 1 || y === RH - 1 ||
        grid[y * RW + x - 1] < 0 || grid[y * RW + x + 1] < 0 ||
        grid[(y - 1) * RW + x] < 0 || grid[(y + 1) * RW + x] < 0) coastal[id] = 1;
  }

// adjacency: dilate land a few pixels to close sliver gaps between countries,
// then count how many pixel borders each province pair shares
let dil = grid;
for (let pass = 0; pass < GAP_CLOSE; pass++) {
  const next = dil.slice();
  for (let y = 0; y < RH; y++)
    for (let x = 0; x < RW; x++) {
      if (dil[y * RW + x] >= 0) continue;
      const i = y * RW + x;
      let n = -1;
      if (x > 0 && dil[i - 1] >= 0) n = dil[i - 1];
      else if (x < RW - 1 && dil[i + 1] >= 0) n = dil[i + 1];
      else if (y > 0 && dil[i - RW] >= 0) n = dil[i - RW];
      else if (y < RH - 1 && dil[i + RW] >= 0) n = dil[i + RW];
      if (n >= 0) next[i] = n;
    }
  dil = next;
}

const border = new Map(); // "a,b" -> shared pixel edges
const bump = (a, b) => {
  if (a === b || a < 0 || b < 0) return;
  const key = a < b ? `${a},${b}` : `${b},${a}`;
  border.set(key, (border.get(key) || 0) + 1);
};
for (let y = 0; y < RH; y++)
  for (let x = 0; x < RW; x++) {
    const i = y * RW + x, a = dil[i];
    if (a < 0) continue;
    if (x < RW - 1) bump(a, dil[i + 1]);
    if (y < RH - 1) bump(a, dil[i + RW]);
  }

const neighbors = provinces.map(() => []);
for (const [key, n] of border) {
  if (n < 4) continue;  // a few stray pixels is not a real border
  const [a, b] = key.split(',').map(Number);
  neighbors[a].push(b);
  neighbors[b].push(a);
}

// ------------------------------------------------------------------ terrain --

function hash2(x, y, s) {
  const v = Math.sin(x * s * 1.7 + 12.9) * 43758.5453 + Math.sin(y * s * 2.3 + 78.2) * 12345.6789;
  return v - Math.floor(v);
}
const RANGES = [ // coarse mountain belts: lon0, lat0, lon1, lat1
  [-125, 30, -105, 60], [-80, -56, -62, 9], [4, 43, 17, 48], [-10, 27, 10, 36],
  [60, 25, 100, 42], [36, 36, 50, 45], [55, 50, 70, 68], [128, 32, 146, 46],
  [-152, 55, -125, 68], [95, -12, 145, 5], [20, -34, 32, -22], [166, -47, 176, -34],
  [8, 59, 18, 70], [24, 42, 30, 47],
];
function terrainFor(lon, lat, isCoastal) {
  const alat = Math.abs(lat);
  for (const [a, b, c, d] of RANGES)
    if (lon >= a && lon <= c && lat >= b && lat <= d)
      return hash2(lon, lat, 9) > 0.35 ? 'mountain' : 'hills';
  if (alat > 68) return 'arctic';
  if (alat > 59) return hash2(lon, lat, 5) > 0.5 ? 'tundra' : 'forest';
  const dry = hash2(lon, lat, 3);
  if (alat > 15 && alat < 34 && dry > 0.42) return 'desert';
  if (alat < 11 && dry > 0.3) return 'jungle';
  if (alat < 24 && dry > 0.62) return 'jungle';
  const n = hash2(lon + 300, lat - 40, 4);
  if (n > 0.68) return 'forest';
  if (n > 0.52) return 'hills';
  if (n < 0.12 && !isCoastal) return 'marsh';
  return 'plains';
}

// ------------------------------------------------------------------- naming --

const SYL = {
  eu: ['al', 'ber', 'brand', 'cast', 'dor', 'ess', 'fried', 'gron', 'hall', 'kirch', 'lem', 'mont', 'nor', 'ost', 'pol', 'rav', 'stein', 'thal', 'ver', 'wald', 'ynn', 'karl', 'novo', 'lju'],
  as: ['an', 'bao', 'chang', 'dai', 'fu', 'gan', 'hoi', 'jin', 'kan', 'lung', 'mai', 'nan', 'qin', 'shan', 'tai', 'wei', 'xia', 'yang', 'zhou', 'raj', 'pur', 'kot'],
  af: ['aba', 'bam', 'dou', 'gara', 'ilo', 'kano', 'lubu', 'mba', 'nde', 'ouag', 'sene', 'tim', 'zari', 'kwa', 'sofa'],
  am: ['alta', 'buena', 'cerro', 'del', 'esca', 'huan', 'lago', 'mira', 'nuevo', 'porto', 'rio', 'santa', 'valle', 'fort', 'grand'],
  tail: ['a', 'burg', 'dale', 'field', 'grad', 'heim', 'ia', 'ford', 'mark', 'ov', 'sk', 'ton', 'vik', 'mouth', 'bury'],
};
const regionOf = (lon, lat) =>
  lon > -30 && lon < 45 && lat > 34 ? 'eu'
    : lon >= 45 || lon < -170 ? 'as'
      : lon > -30 && lat <= 34 ? 'af' : 'am';
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
function nameFor(lon, lat) {
  const pool = SYL[regionOf(lon, lat)];
  return cap(pick(pool) + (rng() < 0.55 ? pick(pool) : pick(SYL.tail)));
}

// ------------------------------------------------------------ country colors --

const cAdj = countries.map(() => new Set());
provinces.forEach((pv, id) => {
  for (const nb of neighbors[id]) {
    const o = provinces[nb].country;
    if (o !== pv.country) { cAdj[pv.country].add(o); cAdj[o].add(pv.country); }
  }
});

const PALETTE = [
  '#8f9bb3', '#b3897a', '#8aa87f', '#a99ac2', '#c2ae76', '#7fa3ad', '#b98c9e', '#95ad9b',
  '#a6a08c', '#9d8fa8', '#7f96a8', '#b8a184', '#8ba38f', '#ab8f92', '#96a6bb', '#c0b295',
  '#87998a', '#a4849b', '#9aa77e', '#b0968f', '#8e94a6', '#a8b09a', '#bb9c85', '#849aa0',
];
const FIXED = {
  Germany: '#6d7684', 'United States of America': '#4f8a6b', Russia: '#a8464a',
  'United Kingdom': '#9a6b52', France: '#4f7ba3', Italy: '#5f9a8f', Japan: '#b0705f',
  China: '#c2a15c', India: '#9c8a5e', Brazil: '#79a35f', Canada: '#8a6f9a', Spain: '#c29a4f',
};
const colors = new Array(countries.length).fill(null);
countries.forEach((c, i) => { if (FIXED[c.name]) colors[i] = FIXED[c.name]; });
for (const i of countries.map((_, i) => i).sort((a, b) => cAdj[b].size - cAdj[a].size)) {
  if (colors[i]) continue;
  const used = new Set([...cAdj[i]].map((j) => colors[j]).filter(Boolean));
  colors[i] = PALETTE.find((p) => !used.has(p)) ?? PALETTE[i % PALETTE.length];
}

// ---------------------------------------------------------------- serialise --

const toGeo = (poly) => poly.map((ring) => {
  const out = ring.map(([x, y]) => {
    const ll = unproject(x, y);
    return [round4(ll[0]), round4(ll[1])];
  });
  // snapping can collapse a duplicate closing vertex; keep rings closed
  const [a, b] = [out[0], out[out.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out;
});

// --------------------------------------------------- real subdivision names --
// Assign names once the partition exists: a cell takes the name of the real
// administrative unit its centre sits in, numbered when several cells share one.
const subdivisionOf = provinces.map(() => null);
{
  const used = new Map();
  provinces.forEach((pv, id) => {
    let best = pv.parts[0], bestA = -1;
    for (const p of pv.parts) { const a = polyArea(p); if (a > bestA) { bestA = a; best = p; } }
    let cx = 0, cy = 0;
    for (const [x, y] of best[0]) { cx += x; cy += y; }
    const [lon, lat] = unproject(cx / best[0].length, cy / best[0].length);
    const sub = admin1.lookup(lon, lat, countries[pv.country].name);
    if (!sub) return;
    subdivisionOf[id] = sub;
    const key = `${pv.country}|${sub}`;
    used.set(key, (used.get(key) ?? 0) + 1);
  });
  const seen = new Map();
  provinces.forEach((pv, id) => {
    const sub = subdivisionOf[id];
    if (!sub) return;
    const key = `${pv.country}|${sub}`;
    const total = used.get(key) ?? 1;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    pv.state = sub;
    pv.label = total > 1 ? `${sub} ${ROMAN[n - 1] ?? n}` : sub;
  });
}

const outProvinces = provinces.map((pv, id) => {
  let best = pv.parts[0], bestA = -1;
  for (const p of pv.parts) { const a = polyArea(p); if (a > bestA) { bestA = a; best = p; } }
  let cx = 0, cy = 0;
  for (const [x, y] of best[0]) { cx += x; cy += y; }
  cx /= best[0].length; cy /= best[0].length;
  if (!pointInPoly(cx, cy, best)) {           // label point must sit on land
    const [x0, y0, x1, y1] = bboxOf(best[0]);
    for (let t = 0; t < 60; t++) {
      const x = x0 + rng() * (x1 - x0), y = y0 + rng() * (y1 - y0);
      if (pointInPoly(x, y, best)) { cx = x; cy = y; break; }
    }
  }
  const [lon, lat] = unproject(cx, cy);
  return {
    id,
    n: pv.label ?? nameFor(lon, lat),
    state: pv.state ?? null,
    c: pv.country,
    x: round1(cx), y: round1(cy),
    a: Math.round(pv.area),
    t: terrainFor(lon, lat, !!coastal[id]),
    o: coastal[id] ? 1 : 0,
    lon: round4(lon), lat: round4(lat),
    nb: neighbors[id].sort((a, b) => a - b),
  };
});

// ------------------------------------------------------------------ islands --
//
// Islands too small to justify a province of their own were dropped, which
// left real land missing from the map: a coastline with holes in it, and no
// ground under Lemnos or the Aegean or the Hebrides. They are put back as
// geometry rather than as provinces - each one joins the nearest province of
// its own country as another part of a multipolygon - so the borders include
// them without adding a single cell to the province graph, the frontline
// index, or the command hierarchy, all of which scale with province count.
{
  const centre = (rings) => {
    let x = 0, y = 0;
    for (const [px, py] of rings[0]) { x += px; y += py; }
    return [x / rings[0].length, y / rings[0].length];
  };
  // an island of a few square kilometres is a rock; below this it is not worth
  // the bytes it would cost every client to download
  const MIN_KEEP_KM2 = 8;
  const byCountry = new Map();
  provinces.forEach((pv, id) => {
    const list = byCountry.get(pv.country) ?? [];
    list.push(id);
    byCountry.set(pv.country, list);
  });

  let added = 0, rocks = 0;
  countries.forEach((c, ci) => {
    const home = byCountry.get(ci);
    if (!home?.length) return;
    const anchors = home.map((id) => ({ id, at: centre(provinces[id].parts[0]) }));
    for (const poly of c.polys) {
      if (c.kept.includes(poly)) continue;              // already has provinces
      if (poly.km2 < MIN_KEEP_KM2) { rocks++; continue; }
      const [ix, iy] = centre(poly.rings);
      let best = anchors[0], bestD = Infinity;
      for (const a of anchors) {
        const d = (a.at[0] - ix) ** 2 + (a.at[1] - iy) ** 2;
        if (d < bestD) { bestD = d; best = a; }
      }
      provinces[best.id].parts.push(poly.rings);
      added++;
    }
  });
  console.log(`islands    ${added} attached to existing provinces, ${rocks} rocks under ${MIN_KEEP_KM2} km2 skipped`);
}

// GeoJSON for the renderer: one feature per province, geometry in WGS84
const geojson = {
  type: 'FeatureCollection',
  features: provinces.map((pv, id) => {
    const p = outProvinces[id];
    const polys = pv.parts.map(toGeo);
    return {
      type: 'Feature',
      id,
      properties: {
        id, name: p.n, state: p.state, country: p.c, countryName: countries[p.c].name,
        terrain: p.t, coastal: p.o, area: p.a,
      },
      geometry: polys.length === 1
        ? { type: 'Polygon', coordinates: polys[0] }
        : { type: 'MultiPolygon', coordinates: polys },
    };
  }),
};

const out = {
  width: MAP_W,
  height: MAP_H,
  latClip: LAT_CLIP,
  countries: countries.map((c, i) => ({ id: i, name: c.name, color: colors[i] })),
  provinces: outProvinces,
};

fs.mkdirSync(path.join(root, 'public/data'), { recursive: true });
const file = path.join(root, 'public/data/world.json');
fs.writeFileSync(file, JSON.stringify(out));
const geoFile = path.join(root, 'public/data/provinces.geojson');
const geoJson = JSON.stringify(geojson);
fs.writeFileSync(geoFile, geoJson);
// real subdivision geometry is detailed; ship it compressed
fs.writeFileSync(`${geoFile}.gz`, zlib.gzipSync(geoJson, { level: 9 }));

// ------------------------------------------------------------------ report --

const seen = new Uint8Array(outProvinces.length);
const comps = [];
for (let i = 0; i < outProvinces.length; i++) {
  if (seen[i]) continue;
  const st = [i]; seen[i] = 1; let n = 0;
  while (st.length) {
    const c = st.pop(); n++;
    for (const b of outProvinces[c].nb) if (!seen[b]) { seen[b] = 1; st.push(b); }
  }
  comps.push(n);
}
comps.sort((a, b) => b - a);
const verts = geojson.features.reduce((s, f) => {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return s + polys.reduce((t, poly) => t + poly.reduce((u, r) => u + r.length, 0), 0);
}, 0);
const byCountry = {};
for (const p of outProvinces) byCountry[countries[p.c].name] = (byCountry[countries[p.c].name] || 0) + 1;

console.log(`map        ${MAP_W}x${MAP_H}  raster ${RW}x${RH}`);
console.log(`countries  ${countries.length} (${countries.filter((c) => c.real).length} with real subdivisions)`);
console.log(`named      ${outProvinces.filter((p) => p.state).length}/${outProvinces.length} provinces from real administrative units`);
console.log(`provinces  ${outProvinces.length}  (coastal ${outProvinces.filter((p) => p.o).length})`);
console.log(`neighbors  avg ${(outProvinces.reduce((s, p) => s + p.nb.length, 0) / outProvinces.length).toFixed(2)}, isolated ${outProvinces.filter((p) => !p.nb.length).length}`);
console.log(`landmasses ${comps.length}, largest ${comps.slice(0, 5).join(' ')}`);
console.log(`top        ${Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${n} ${c}`).join(', ')}`);
console.log(`vertices   ${verts}`);
console.log(`size       world.json ${(fs.statSync(file).size / 1e6).toFixed(2)} MB, provinces.geojson ${(fs.statSync(geoFile).size / 1e6).toFixed(2)} MB (${(fs.statSync(`${geoFile}.gz`).size / 1e6).toFixed(2)} MB gzipped)`);
