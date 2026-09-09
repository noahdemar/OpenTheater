import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Scenario } from '../game/scenario';
import { atWar } from '../game/scenario';
import type { World } from '../game/world';

type Pt = [number, number];
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
function smoothChains(chains: Pt[][], passes = 2): Pt[][] {
  return chains.map((chain) => {
    if (chain.length < 3) return chain;
    let pts = chain;
    for (let pass = 0; pass < passes; pass++) {
      const out: Pt[] = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    // thin the result back down; smoothing quadruples the point count
    return pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
  });
}

/**
 * The political layer: province ownership, the frontline, and selection.
 *
 * Ownership colour lives in MapLibre feature state, so flipping a province is
 * one call rather than a restyle of the whole source.
 */
export class PoliticalLayer {
  private frontlineData: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

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

  /** Called from the main loop; rebuilds only when something actually changed. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.rebuildFrontline();
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
