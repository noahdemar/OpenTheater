import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Scenario } from '../game/scenario';
import { atWar } from '../game/scenario';
import type { World } from '../game/world';
import type { Zones } from '../game/zones';

type Pt = [number, number];
type Ring = Pt[];
const key = (p: Pt) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

/**
 * Join loose border segments end to end into the longest runs possible, so a
 * front reads as one line rather than a few hundred disconnected province
 * edges.
 */
function chainSegments(segments: Pt[][]): Pt[][] {
  const ends = new Map<string, Pt[][]>();
  const add = (k: string, seg: Pt[]) => {
    const list = ends.get(k) ?? [];
    list.push(seg);
    ends.set(k, list);
  };
  const remaining = new Set(segments);
  for (const seg of segments) { add(key(seg[0]), seg); add(key(seg[seg.length - 1]), seg); }

  const chains: Pt[][] = [];
  for (const start of segments) {
    if (!remaining.has(start)) continue;
    remaining.delete(start);
    const chain = [...start];

    // extend from both ends while a segment continues the run
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? chain[chain.length - 1] : chain[0];
        const next = (ends.get(key(tip)) ?? []).find((s) => remaining.has(s));
        if (!next) break;
        remaining.delete(next);
        const flip = key(next[0]) !== key(tip);
        const rest = flip ? [...next].reverse().slice(1) : next.slice(1);
        if (forward) chain.push(...rest);
        else chain.unshift(...[...rest].reverse());
      }
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * Which side of a front line this nation's ground lies on: +1 or -1 along the
 * line's left normal, 0 if it cannot be told. Decided once per chain by
 * sampling three points - doing it per vertex would be exact but costs a
 * province lookup for every point on every rebuild.
 */
function ownGroundSide(
  line: Pt[], side: number, scn: Scenario, world: World, degrees = 0.12,
): number {
  const normalAt = (i: number): Pt => {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [-dy / len, dx / len];
  };

  let votes = 0;
  for (const i of [Math.floor(line.length * 0.25), Math.floor(line.length * 0.5), Math.floor(line.length * 0.75)]) {
    const [nx, ny] = normalAt(i);
    const plus = world.provinceAt(line[i][0] + nx * degrees, line[i][1] + ny * degrees);
    const minus = world.provinceAt(line[i][0] - nx * degrees, line[i][1] - ny * degrees);
    if (scn.controller[plus] === side) votes++;
    if (scn.controller[minus] === side) votes--;
  }
  return votes === 0 ? 0 : votes > 0 ? 1 : -1;
}

/** Chaikin corner-cutting: takes the saw teeth off a Voronoi border. */
/**
 * The stretch of boundary two zones share.
 *
 * Zone cells are clipped from the same Voronoi diagram, so a shared edge is
 * byte-identical in both - the same trick the province geometry uses - and can
 * be found by hashing points rather than by intersecting polygons.
 */
function sharedEdge(a: Ring[], b: Ring[]): Pt[] | null {
  const mine = new Set<string>();
  const key = (p: number[]) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  for (const ring of a) for (const p of ring) mine.add(key(p));
  const run: Pt[] = [];
  for (const ring of b) {
    for (const p of ring) {
      if (mine.has(key(p))) run.push([p[0], p[1]]);
      else if (run.length >= 2) return run;
      else run.length = 0;
    }
  }
  return run.length >= 2 ? run : null;
}

/** Great-circle-ish distance in degrees, good enough for stitching endpoints. */
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Join chains whose ends very nearly meet.
 *
 * Province edges are quantised onto a lattice, so a front that is continuous
 * on the ground can still arrive as two chains whose endpoints differ in the
 * last decimal - typically where three provinces meet. Stitching those closes
 * the gaps that make a front look like dashes rather than a line.
 */
function stitchChains(chains: Pt[][], tol = 0.05): Pt[][] {
  const open = chains.filter((c) => c.length > 1);
  const out: Pt[][] = [];
  const used = new Set<Pt[]>();

  for (const start of open) {
    if (used.has(start)) continue;
    used.add(start);
    const chain = [...start];
    for (let grew = true; grew;) {
      grew = false;
      for (const other of open) {
        if (used.has(other)) continue;
        const head = chain[0], tail = chain[chain.length - 1];
        const oh = other[0], ot = other[other.length - 1];
        if (dist(tail, oh) <= tol) { chain.push(...other.slice(1)); }
        else if (dist(tail, ot) <= tol) { chain.push(...[...other].reverse().slice(1)); }
        else if (dist(head, ot) <= tol) { chain.unshift(...other.slice(0, -1)); }
        else if (dist(head, oh) <= tol) { chain.unshift(...[...other].reverse().slice(0, -1)); }
        else continue;
        used.add(other);
        grew = true;
      }
    }
    out.push(chain);
  }
  return out;
}

/**
 * Resample a chain to roughly even spacing.
 *
 * Corner-cutting rounds each vertex by the same proportion, so on a polyline
 * whose segments vary wildly in length - which province edges do - it leaves
 * the short stretches over-rounded and the long ones straight. Evening the
 * spacing first is what turns a lumpy border into a fair curve.
 */
function resample(chain: Pt[], step: number): Pt[] {
  if (chain.length < 3) return chain;
  const out: Pt[] = [chain[0]];
  let carry = 0;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    const d = dist(a, b);
    if (d === 0) continue;
    let t = (step - carry) / d;
    while (t <= 1) {
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      t += step / d;
    }
    carry = (carry + d) % step;
  }
  const last = chain[chain.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push(last);
  return out;
}

/**
 * Chaikin corner-cutting, with the ends pinned so a front does not creep away
 * from the ground it belongs to.
 */
function chaikin(pts: Pt[], passes: number): Pt[] {
  let cur = pts;
  for (let pass = 0; pass < passes; pass++) {
    if (cur.length < 3) break;
    const out: Pt[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/**
 * Turn raw province edges into fronts that read as fronts: stitched end to
 * end, evenly sampled, rounded, and with the specks thrown away.
 *
 * A single province edge floating on its own is not a front - it is noise from
 * one cell changing hands - and drawing it is what made the line look like
 * scattered dashes.
 */
function smoothChains(chains: Pt[][], passes = 3): Pt[][] {
  const MIN_LENGTH_DEG = 0.35;                 // shorter than this is a speck
  const out: Pt[][] = [];
  for (const chain of stitchChains(chains)) {
    let span = 0;
    for (let i = 1; i < chain.length; i++) span += dist(chain[i - 1], chain[i]);
    if (span < MIN_LENGTH_DEG) continue;
    out.push(chaikin(resample(chain, Math.max(0.04, span / 160)), passes));
  }
  return out;
}

/**
 * The political layer: province ownership, the frontline, and selection.
 *
 * Ownership colour lives in MapLibre feature state, so flipping a province is
 * one call rather than a restyle of the whole source.
 */
export class PoliticalLayer {
  private frontlineData: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

  /**
   * Sub-province ground, once it exists. Zones are generated only for the
   * provinces that are actually contested, so most of the map never has any.
   */
  zones: Zones | null = null;

  constructor(private map: MapLibreMap, private world: World, private scn: Scenario) {}

  add() {
    const { map } = this;
    map.addSource('provinces', {
      type: 'geojson',
      data: this.world.geojson,
      promoteId: 'id',
      generateId: false,
    });
    map.addSource('frontline', { type: 'geojson', data: this.frontlineData });
    map.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    const ownerColor = ['coalesce', ['feature-state', 'color'], '#8b8b8b'] as never;

    map.addLayer({
      id: 'provinces/fill',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-color': ownerColor,
        // strong political colour when zoomed out, a wash once terrain matters
        'fill-opacity': ['interpolate', ['linear'], ['zoom'],
          2, 0.82, 5, 0.72, 8, 0.42, 11, 0.18, 13, 0.07, 15, 0] as never,
      },
    }, 'boundaries/region');

    // Ground held but not owned gets a hatch, the way an occupation is drawn
    // on a paper map. The state is already tracked; it was simply never shown.
    map.addLayer({
      id: 'provinces/occupied',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-pattern': 'hatch',
        // feature-state is not allowed in a filter, so the hatch is switched on
        // through its opacity instead
        // A zoom interpolation has to be the outermost expression, so the
        // occupied test goes inside each stop rather than wrapping the whole.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'],
          2, ['case', ['==', ['feature-state', 'occupied'], true], 0.5, 0],
          8, ['case', ['==', ['feature-state', 'occupied'], true], 0.38, 0],
          13, ['case', ['==', ['feature-state', 'occupied'], true], 0.18, 0]] as never,
      },
    }, 'boundaries/region');

    // Ground taken inside a province, drawn over the province's own colour.
    // A cell that is being fought through shows the bite that has been taken
    // out of it rather than flipping whole when the defence finally breaks.
    map.addLayer({
      id: 'zones/fill',
      type: 'fill',
      source: 'zones',
      paint: {
        'fill-color': ['get', 'color'] as never,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'],
          2, 0.82, 5, 0.72, 8, 0.42, 11, 0.18, 13, 0.07, 15, 0] as never,
      },
    }, 'boundaries/region');
    map.addLayer({
      id: 'zones/outline',
      type: 'line',
      source: 'zones',
      paint: {
        'line-color': '#2b241d',
        'line-width': 0.4,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.12, 8, 0.28, 12.5, 0] as never,
      },
    }, 'boundaries/region');

    map.addLayer({
      id: 'provinces/outline',
      type: 'line',
      source: 'provinces',
      paint: {
        'line-color': '#2b241d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.3, 7, 0.6, 11, 1.1] as never,
        // province lines are a strategic abstraction: below corps scale they
        // would just cut arbitrarily across streets, so they fade away
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.25, 7, 0.4, 10, 0.45, 12.5, 0] as never,
      },
    }, 'boundaries/region');

    map.addLayer({
      id: 'provinces/hover',
      type: 'line',
      source: 'provinces',
      filter: ['==', ['id'], -1],
      paint: { 'line-color': '#f2e3bd', 'line-width': 1.6, 'line-opacity': 0.9 },
    });

    map.addLayer({
      id: 'provinces/selected',
      type: 'line',
      source: 'provinces',
      filter: ['==', ['id'], -1],
      paint: { 'line-color': '#ffd479', 'line-width': 2.4 },
    });

    // The front reads the way a wargame draws it: each side's colour laid
    // along its own ground, with a dark contact line between them.
    map.addLayer({
      id: 'frontline/glow',
      type: 'line',
      source: 'frontline',
      filter: ['==', ['get', 'band'], 1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'] as never,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 20, 12, 34] as never,
        'line-opacity': 0.3,
        'line-blur': ['interpolate', ['linear'], ['zoom'], 2, 6, 12, 22] as never,
        'line-offset': ['interpolate', ['linear'], ['zoom'],
          2, ['*', ['get', 'dir'], 7],
          6, ['*', ['get', 'dir'], 13],
          12, ['*', ['get', 'dir'], 22]] as never,
      },
    });
    map.addLayer({
      id: 'frontline/band',
      type: 'line',
      source: 'frontline',
      filter: ['==', ['get', 'band'], 1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'] as never,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2.4, 6, 4, 12, 7] as never,
        'line-opacity': 0.95,
        'line-offset': ['interpolate', ['linear'], ['zoom'],
          2, ['*', ['get', 'dir'], 4],
          6, ['*', ['get', 'dir'], 8],
          12, ['*', ['get', 'dir'], 14]] as never,
      },
    });
    map.addLayer({
      id: 'frontline/line',
      type: 'line',
      source: 'frontline',
      filter: ['==', ['get', 'band'], 0],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#140b08',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 6, 2, 12, 3.2] as never,
        'line-opacity': 0.8,
      },
    });

    map.addSource('victory', { type: 'geojson', data: this.victoryPoints() });
    map.addLayer({
      id: 'victory/dot',
      type: 'symbol',
      source: 'victory',
      minzoom: 3,
      layout: {
        'icon-image': 'vp',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 7, 0.62, 12, 0.8] as never,
        'icon-allow-overlap': true,
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 0, 5.5, 10, 10, 12] as never,
        'text-anchor': 'left',
        'text-offset': [0.8, 0],
        'text-optional': true,
      },
      paint: {
        'text-color': '#f0dfae',
        'text-halo-color': 'rgba(10,12,15,0.9)',
        'text-halo-width': 1.4,
      },
    });

    this.refreshAll();
  }

  /** Push every province's owner colour into feature state. */
  refreshAll() {
    const { map, scn } = this;
    for (let id = 0; id < scn.controller.length; id++) this.setProvinceOwner(id);
    void map;
    this.rebuildFrontline();
  }

  /** Colour overrides the editor paints on top of the live scenario. */
  readonly overrides = new Map<number, string>();

  setProvinceOwner(id: number) {
    const override = this.overrides.get(id);
    if (override) {
      this.map.setFeatureState({ source: 'provinces', id }, { color: override, occupied: false });
      return;
    }
    const nation = this.scn.nations.get(this.scn.controller[id]);
    const occupied = this.scn.controller[id] !== this.scn.owner[id];
    this.map.setFeatureState({ source: 'provinces', id }, {
      color: nation?.color ?? '#8b8b8b',
      occupied,
    });
  }

  /**
   * The frontline is every shared province border where the two sides are at
   * war. Borders are exact shared segments from the build step, so the line
   * follows real province geometry rather than an approximation.
   */
  /**
   * Ask for a frontline rebuild. Captures come in bursts - dozens of provinces
   * can change hands in a second at high speed - and chaining and smoothing
   * twenty thousand border segments for each one is wasted work.
   */
  private dirty = false;

  markFrontlineDirty() { this.dirty = true; }

  private zonesDirty = false;

  markZonesDirty() { this.zonesDirty = true; this.dirty = true; }

  /** Called from the main loop; rebuilds only when something actually changed. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.zonesDirty) { this.zonesDirty = false; this.rebuildZones(); }
    this.rebuildFrontline();
  }

  /**
   * Redraw the ground held inside contested provinces. Only zones that have
   * actually changed hands are drawn: the rest of the cell is already the
   * right colour underneath.
   */
  rebuildZones() {
    const { zones, scn } = this;
    const features: GeoJSON.Feature[] = [];
    if (zones) {
      for (const province of zones.provinces) {
        const held = scn.controller[province];
        for (const z of zones.of(province)) {
          const owner = zones.holderOf(z, held);
          if (owner === held) continue;
          features.push({
            type: 'Feature',
            properties: { color: scn.nations.get(owner)?.color ?? '#8b8b8b', zone: z.id },
            geometry: { type: 'Polygon', coordinates: [z.rings[0]] },
          });
        }
      }
    }
    (this.map.getSource('zones') as GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features });
    return features.length;
  }

  /**
   * The edges inside a province where the ground on either side is held by
   * sides at war: the front where it runs through a cell rather than along the
   * boundary between two.
   */
  private zoneFrontSegments(): Map<number, Pt[][]> {
    const bySide = new Map<number, Pt[][]>();
    const { zones, scn } = this;
    if (!zones) return bySide;
    for (const province of zones.provinces) {
      const held = scn.controller[province];
      // Ask the cheap question first. Most provinces are cut into zones simply
      // because a battle passed through them, and never actually split.
      if (!zones.contested(province, held)) continue;
      const list = zones.of(province);
      for (const z of list) {
        const mine = zones.holderOf(z, held);
        for (const j of z.nb) {
          if (j < z.index) continue;                 // each edge once
          const other = list[j];
          const theirs = zones.holderOf(other, held);
          if (mine === theirs || !atWar(scn, mine, theirs)) continue;
          const seg = sharedEdge(z.rings, other.rings);
          if (!seg) continue;
          for (const side of [mine, theirs]) {
            const acc = bySide.get(side) ?? [];
            acc.push(seg);
            bySide.set(side, acc);
          }
        }
      }
    }
    return bySide;
  }

  rebuildFrontline() {
    const { world, scn } = this;
    const features: GeoJSON.Feature[] = [];

    // Gather the contested segments per defending side, then chain and smooth
    // them: a front should read as one continuous line across the map, not as
    // a scatter of individual province edges.
    const bySide = new Map<number, Pt[][]>();
    for (const [pair, segments] of world.borders) {
      const [a, b] = pair.split(':').map(Number);
      const ca = scn.controller[a], cb = scn.controller[b];
      if (ca === cb || !atWar(scn, ca, cb)) continue;
      // both sides of a contested border get their own line: the front is two
      // armies facing each other, not one boundary
      for (const side of [ca, cb]) {
        const list = bySide.get(side) ?? [];
        list.push(...(segments as Pt[][]));
        bySide.set(side, list);
      }
    }

    // a front runs through contested provinces as well as between them
    for (const [side, segs] of this.zoneFrontSegments()) {
      const list = bySide.get(side) ?? [];
      list.push(...segs);
      bySide.set(side, list);
    }

    const spinesDrawn = new Set<Pt[]>();
    for (const [side, segments] of bySide) {
      const colour = this.scn.nations.get(side)?.color ?? '#999';
      for (const line of smoothChains(chainSegments(segments))) {
        if (line.length < 2) continue;
        // the contact itself, drawn once
        if (!spinesDrawn.has(line)) {
          spinesDrawn.add(line);
          features.push({
            type: 'Feature',
            properties: { color: colour, side, band: 0 },
            geometry: { type: 'LineString', coordinates: line },
          });
        }
        // A band of this side's colour, laid on this side's ground. The shift
        // is applied by the renderer in screen pixels rather than baked into
        // the geometry, so the two sides stay the same distance apart whether
        // you are looking at a continent or a valley.
        const dir = ownGroundSide(line, side, scn, world);
        if (dir !== 0) {
          features.push({
            type: 'Feature',
            properties: { color: colour, side, band: 1, dir },
            geometry: { type: 'LineString', coordinates: line },
          });
        }
      }
    }

    this.frontlineData = { type: 'FeatureCollection', features };
    (this.map.getSource('frontline') as GeoJSONSource | undefined)?.setData(this.frontlineData);
    return features.length;
  }

  /** The places worth taking: capitals and cities that score. */
  private victoryPoints(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (const [province, value] of this.scn.victoryPoints) {
      const p = this.world.province(province);
      if (!p) continue;
      features.push({
        type: 'Feature',
        properties: { name: p.n, value },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  setHover(id: number | null) {
    this.map.setFilter('provinces/hover', ['==', ['id'], id ?? -1]);
  }

  setSelected(ids: number[]) {
    this.map.setFilter('provinces/selected',
      ids.length ? ['in', ['id'], ['literal', ids]] : ['==', ['id'], -1]);
  }
}
