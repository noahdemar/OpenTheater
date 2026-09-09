import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ConflictModel } from '../game/conflicts';

/**
 * The intensity overlay: every province a listed conflict is fought over,
 * washed in the colour of its band. It reads the way the article's own map
 * does - maroon for the major wars down to yellow for skirmishes - and sits
 * above the political fill so it survives whoever happens to hold the ground.
 */
export class ConflictLayer {
  private ids: number[] = [];

  constructor(private map: MapLibreMap) {}

  add() {
    if (this.map.getLayer('conflicts/fill')) return;
    this.map.addLayer({
      id: 'conflicts/fill',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-color': ['coalesce', ['feature-state', 'conflictColor'], 'rgba(0,0,0,0)'] as never,
        // heaviest at strategic zoom, gone by the time streets are drawn
        // A tint, not a flood: the political map underneath still has to be
        // legible, and dozens of neighbouring provinces carry this at once.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'],
          2, ['*', 0.34, ['coalesce', ['feature-state', 'conflictWeight'], 0]],
          6, ['*', 0.2, ['coalesce', ['feature-state', 'conflictWeight'], 0]],
          10, ['*', 0.08, ['coalesce', ['feature-state', 'conflictWeight'], 0]],
          13, 0] as never,
      },
    }, 'boundaries/region');

    this.map.addLayer({
      id: 'conflicts/edge',
      type: 'line',
      source: 'provinces',
      paint: {
        'line-color': ['coalesce', ['feature-state', 'conflictColor'], 'rgba(0,0,0,0)'] as never,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.4, 8, 0.9] as never,
        'line-opacity': ['interpolate', ['linear'], ['zoom'],
          2, ['*', 0.5, ['coalesce', ['feature-state', 'conflictWeight'], 0]],
          8, ['*', 0.28, ['coalesce', ['feature-state', 'conflictWeight'], 0]],
          12, 0] as never,
      },
    }, 'boundaries/region');
  }

  /** Paint a model onto the map, clearing whatever was there before. */
  apply(model: ConflictModel, tierColor: (tier: string) => string) {
    this.clear();
    for (const [province, st] of model.worst) {
      this.map.setFeatureState({ source: 'provinces', id: province }, {
        conflictColor: tierColor(st.record.tier),
        // a floor, so a skirmish is still visible, and a ceiling short of solid
        conflictWeight: 0.28 + st.intensity * 0.6,
      });
      this.ids.push(province);
    }
  }

  clear() {
    for (const id of this.ids) {
      this.map.setFeatureState({ source: 'provinces', id }, { conflictColor: null, conflictWeight: 0 });
    }
    this.ids = [];
  }

  set visible(on: boolean) {
    for (const id of ['conflicts/fill', 'conflicts/edge']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }
}
