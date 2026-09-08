import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { MISSIONS, footprintDeg, footprintRing, type Satellite, type Satellites } from '../game/satellites';

/**
 * Satellites on the map: the patch of ground each one can currently see, the
 * track it is about to fly, and the spacecraft itself.
 *
 * Footprints are geometry, not styling - a geostationary satellite really does
 * cover a third of the earth and a 500 km imaging pass really is a few
 * thousand kilometres across - so they are drawn at their true size and the
 * scale of space power is visible at a glance.
 */
export class SatelliteLayer {
  visible = false;
  /** only these missions are drawn; empty means all of them */
  readonly missions = new Set<string>();
  /** whose satellites to draw; null for everyone's */
  owner: number | null = null;
  /**
   * Whose ground tracks to draw. Every constellation on screen at once is
   * unreadable, and a track only tells you something about a satellite you
   * command, so by default this is the player's own.
   */
  trackOwner: number | null = null;

  private empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

  constructor(private map: MapLibreMap, private sats: Satellites,
              private colorOf: (owner: number) => string) {}

  add() {
    const { map } = this;
    for (const id of ['sat-footprints', 'sat-tracks', 'sat-points']) {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: this.empty });
    }

    map.addLayer({
      id: 'satellites/footprint',
      type: 'fill',
      source: 'sat-footprints',
      paint: {
        'fill-color': ['get', 'color'] as never,
        // Coverage is filled only where the fill still means something. A
        // geostationary footprint covers a third of the planet and there are
        // dozens of them: filling those paints the whole map, so high orbits
        // are drawn as an outline and only low passes are washed in.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'],
          0, ['*', ['get', 'fill'], 1],
          6, ['*', ['get', 'fill'], 0.7],
          9, ['*', ['get', 'fill'], 0.35]] as never,
      },
    });
    map.addLayer({
      id: 'satellites/footprint-edge',
      type: 'line',
      source: 'sat-footprints',
      paint: {
        'line-color': ['get', 'color'] as never,
        'line-width': 1.1,
        'line-opacity': ['get', 'edge'] as never,
        'line-dasharray': [3, 2] as never,
      },
    });
    map.addLayer({
      id: 'satellites/track',
      type: 'line',
      source: 'sat-tracks',
      paint: {
        'line-color': ['get', 'color'] as never,
        'line-width': 1,
        'line-opacity': 0.4,
      },
    });
    map.addLayer({
      id: 'satellites/point',
      type: 'circle',
      source: 'sat-points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 3, 5, 5] as never,
        'circle-color': ['get', 'color'] as never,
        'circle-stroke-color': '#0a0d10',
        'circle-stroke-width': 1.4,
      },
    });
    map.addLayer({
      id: 'satellites/label',
      type: 'symbol',
      source: 'sat-points',
      minzoom: 3,
      layout: {
        'text-field': ['get', 'label'] as never,
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ['get', 'color'] as never,
        'text-halo-color': 'rgba(8,10,13,0.9)',
        'text-halo-width': 1.2,
      },
    });
    this.setVisible(false);
  }

  private shown(s: Satellite) {
    if (this.owner !== null && s.owner !== this.owner) return false;
    return this.missions.size === 0 || this.missions.has(s.mission);
  }

  setVisible(on: boolean) {
    this.visible = on;
    for (const id of ['satellites/footprint', 'satellites/footprint-edge',
      'satellites/track', 'satellites/point', 'satellites/label']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    if (on) this.update();
  }

  /** Redraw from the satellites' current positions. */
  update() {
    if (!this.visible) return;
    const foot: GeoJSON.Feature[] = [];
    const track: GeoJSON.Feature[] = [];
    const point: GeoJSON.Feature[] = [];

    for (const s of this.sats.all) {
      if (!this.shown(s)) continue;
      const color = MISSIONS[s.mission].color;
      const nation = this.colorOf(s.owner);
      const r = footprintDeg(s.altitudeKm);
      // low orbit: a real patch of ground, worth shading. medium and
      // geostationary: too big to shade, so just its edge.
      const leo = s.altitudeKm < 2000;
      foot.push({
        type: 'Feature',
        properties: {
          color, id: s.id,
          fill: leo ? 0.16 : 0,
          edge: leo ? 0.6 : s.altitudeKm < 30000 ? 0.32 : 0.22,
        },
        geometry: { type: 'Polygon', coordinates: [footprintRing(s.lon, s.lat, r)] },
      });
      point.push({
        type: 'Feature',
        properties: { color: nation, label: s.name, id: s.id },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      });
      // The next quarter orbit, so it is clear which way the pass is going. A
      // geostationary satellite has no ground track worth drawing: it hangs
      // over the same spot.
      const drawTrack = s.altitudeKm < 30000
        && (this.trackOwner === null || s.owner === this.trackOwner);
      if (drawTrack) {
        const ahead: [number, number][] = [];
        for (let k = 0; k <= 12; k++) ahead.push(this.sats.future(s, (s.periodMin * 0.25 * k) / 12));
        track.push({
          type: 'Feature',
          properties: { color },
          geometry: { type: 'LineString', coordinates: unwrap(ahead) },
        });
      }
    }

    (this.map.getSource('sat-footprints') as GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: foot });
    (this.map.getSource('sat-tracks') as GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: track });
    (this.map.getSource('sat-points') as GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: point });
  }

  /** Nearest satellite to a screen point, for click-through. */
  hitTest(x: number, y: number, radiusPx = 12): Satellite | null {
    let best: Satellite | null = null, bestD = radiusPx * radiusPx;
    for (const s of this.sats.all) {
      if (!this.shown(s)) continue;
      const p = this.map.project([s.lon, s.lat]);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
}

/** Keep a polyline continuous across the antimeridian. */
function unwrap(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let prev: number | null = null;
  for (const [lon, lat] of pts) {
    let l = lon;
    if (prev !== null) {
      while (l - prev > 180) l -= 360;
      while (prev - l > 180) l += 360;
    }
    prev = l;
    out.push([l, lat]);
  }
  return out;
}
