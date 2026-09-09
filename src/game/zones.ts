/**
 * Sub-province zones.
 *
 * A province is a strategic abstraction roughly a hundred kilometres across.
 * That is the right grain for moving armies and the wrong grain for showing
 * where the fighting has got to: a whole cell flipping at once turns days of
 * grinding into a single jump on the map, and the front line can only ever run
 * along province edges.
 *
 * Zones are a finer level of ground inside a province. They are not shipped -
 * subdividing every province in the world would multiply a twelve megabyte
 * geometry file by an order of magnitude - but generated on demand, from the
 * province polygon the client already has, and only for the provinces that are
 * actually contested. The seeding is deterministic, so every client that
 * subdivides a province gets byte-identical zones without exchanging any.
 */
import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';
import type { World } from './world';

export type Ring = [number, number][];

export interface Zone {
  /** `${province}:${index}` */
  id: string;
  province: number;
  index: number;
  /** centroid, for distance tests and for placing things */
  lon: number;
  lat: number;
  /** the ground it covers; the first ring is the outer one */
  rings: Ring[];
  /** indices of the zones it shares an edge with, inside the same province */
  nb: number[];
  /** which Voronoi seed this cell grew from, for adjacency */
  seed: number;
}

/** Zones a province is cut into. More for a big cell, fewer for a small one. */
function zoneCount(areaDeg2: number): number {
  return Math.max(4, Math.min(24, Math.round(Math.sqrt(areaDeg2) * 9)));
}

/** The most zones a province may be cut into when extra detail is asked for. */
const MAX_DETAIL = 90;

/** Deterministic from the province id alone, so every client agrees. */
function rng(seed: number) {
  let s = (seed * 0x9e3779b1) | 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ringArea = (r: Ring) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  }
  return a / 2;
};

function pointInRing(px: number, py: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[j], b = r[i];
    if ((a[1] > py) !== (b[1] > py) && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export class Zones {
  /** province id -> its zones, once someone has asked for them */
  private byProvince = new Map<number, Zone[]>();
  /** province id -> its outer rings, indexed on first use */
  private outline = new Map<number, Ring[]>();
  /** zone id -> the nation holding it, where that differs from the province */
  readonly controller = new Map<string, number>();
  /**
   * Provinces that want finer ground than their area alone would give them.
   *
   * A front runs through a cell at a scale the default cut cannot resolve: a
   * town five kilometres behind the line lands in whichever twenty-kilometre
   * zone happens to claim it. Asking for detail where a real line of contact
   * runs fixes that without cutting up the whole world.
   */
  private detail = new Map<number, number>();

  /** Ask for this province to be cut more finely. Must precede the first cut. */
  refine(province: number, zones: number) {
    const want = Math.min(MAX_DETAIL, Math.max(this.detail.get(province) ?? 0, zones));
    if (this.detail.get(province) === want) return;
    this.detail.set(province, want);
    this.byProvince.delete(province);          // recut on next use
  }

  constructor(private world: World) {}

  /** The province polygon, as one or more outer rings. */
  private ringsOf(province: number): Ring[] {
    const hit = this.outline.get(province);
    if (hit) return hit;
    const feature = this.world.geojson.features[province];
    const rings: Ring[] = [];
    const g = feature?.geometry;
    if (g?.type === 'Polygon') rings.push(g.coordinates[0] as Ring);
    else if (g?.type === 'MultiPolygon') for (const poly of g.coordinates) rings.push(poly[0] as Ring);
    this.outline.set(province, rings);
    return rings;
  }

  /**
   * Cut a province into zones, or hand back the cut already made.
   *
   * The seeds are scattered inside the province and relaxed twice, which is
   * what stops the cells coming out as slivers along the edges; each cell is
   * then clipped to the province so zones tile it exactly and no zone spills
   * over a national border.
   */
  of(province: number): Zone[] {
    const hit = this.byProvince.get(province);
    if (hit) return hit;

    const rings = this.ringsOf(province);
    const main = rings.length ? rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a)) : null;
    if (!main || main.length < 4) { this.byProvince.set(province, []); return []; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of main) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const n = this.detail.get(province) ?? zoneCount(Math.abs(ringArea(main)));
    const rand = rng(province + 1);

    // scatter seeds inside the province, then relax so they spread out evenly
    const seeds: [number, number][] = [];
    for (let guard = 0; seeds.length < n && guard < n * 200; guard++) {
      const x = minX + rand() * (maxX - minX);
      const y = minY + rand() * (maxY - minY);
      if (pointInRing(x, y, main)) seeds.push([x, y]);
    }
    if (seeds.length < 3) { this.byProvince.set(province, []); return []; }

    const pad = 0.02;
    const bounds: [number, number, number, number] = [minX - pad, minY - pad, maxX + pad, maxY + pad];
    let cells: Ring[] = [];
    let neighbours: number[][] = [];
    for (let pass = 0; pass < 3; pass++) {
      const delaunay = Delaunay.from(seeds);
      const voronoi = delaunay.voronoi(bounds);
      // Adjacency comes from the triangulation, not from comparing clipped
      // rings: clipping a cell against the province boundary can shorten or
      // remove the very edge that proves two cells are neighbours.
      neighbours = seeds.map((_, i) => [...delaunay.neighbors(i)] as number[]);
      cells = [];
      for (let i = 0; i < seeds.length; i++) {
        const cell = voronoi.cellPolygon(i) as Ring | null;
        cells.push(cell ?? []);
      }
      if (pass === 2) break;
      // Lloyd relaxation: walk each seed to the middle of its cell
      for (let i = 0; i < seeds.length; i++) {
        const cell = cells[i];
        if (!cell?.length) continue;
        let cx = 0, cy = 0;
        for (const [x, y] of cell) { cx += x; cy += y; }
        const mx = cx / cell.length, my = cy / cell.length;
        if (pointInRing(mx, my, main)) seeds[i] = [mx, my];
      }
    }

    // clip every cell to the province, so the zones tile it and nothing spills
    const provincePoly = rings.map((r) => [r]) as [number, number][][][];
    const zones: Zone[] = [];
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]?.length) continue;
      let clipped: [number, number][][][];
      try {
        clipped = polygonClipping.intersection([cells[i]] as never, provincePoly as never) as never;
      } catch { continue; }
      if (!clipped?.length) continue;
      const outer: Ring[] = clipped.map((poly) => poly[0] as Ring).filter((r) => r && r.length > 3);
      if (!outer.length) continue;
      const big = outer.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
      let cx = 0, cy = 0;
      for (const [x, y] of big) { cx += x; cy += y; }
      zones.push({
        id: `${province}:${zones.length}`,
        province,
        index: zones.length,
        lon: cx / big.length,
        lat: cy / big.length,
        rings: outer,
        nb: [],
        seed: i,
      });
    }

    // map the surviving cells back onto the seeds, then carry the
    // triangulation's adjacency across
    for (const z of zones) {
      for (const seed of neighbours[z.seed] ?? []) {
        const other = zones.find((x) => x.seed === seed);
        if (other && !z.nb.includes(other.index)) z.nb.push(other.index);
      }
    }

    this.byProvince.set(province, zones);
    return zones;
  }

  /** Has this province been cut up yet? */
  has(province: number) { return this.byProvince.has(province); }

  /** Every province that currently has zones, contested or not. */
  get provinces(): number[] { return [...this.byProvince.keys()]; }

  /** Who holds a zone: its own holder if it has changed hands, else the province's. */
  holderOf(zone: Zone, provinceController: number): number {
    return this.controller.get(zone.id) ?? provinceController;
  }

  /** Is any of this province in other hands than the province itself? */
  contested(province: number, provinceController: number): boolean {
    const zones = this.byProvince.get(province);
    if (!zones) return false;
    return zones.some((z) => this.holderOf(z, provinceController) !== provinceController);
  }

  /**
   * Hand one zone to an attacker: the one they are closest to that they do not
   * already hold, so ground is taken from the direction the attack came from
   * rather than at random across the cell.
   */
  takeNearest(province: number, provinceController: number, attacker: number, from: [number, number]): Zone | null {
    const zones = this.of(province);
    let best: Zone | null = null, bestD = Infinity;
    for (const z of zones) {
      if (this.holderOf(z, provinceController) === attacker) continue;
      const d = (z.lon - from[0]) ** 2 + ((z.lat - from[1]) * 1.4) ** 2;
      if (d < bestD) { bestD = d; best = z; }
    }
    if (!best) return null;
    this.controller.set(best.id, attacker);
    return best;
  }

  /** Does this side now hold every zone of the province? */
  fullyHeld(province: number, provinceController: number, side: number): boolean {
    const zones = this.byProvince.get(province);
    if (!zones?.length) return false;
    return zones.every((z) => this.holderOf(z, provinceController) === side);
  }

  /** Forget a province's zone holdings, once the whole cell has changed hands. */
  reset(province: number) {
    for (const z of this.byProvince.get(province) ?? []) this.controller.delete(z.id);
  }

  clear() { this.controller.clear(); }
}
