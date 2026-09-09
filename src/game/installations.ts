/** Airfields, ports and bases pulled out of the archive by tools/network.mjs. */
export type InstallationType = 'air' | 'port' | 'base';

export interface Installation {
  t: InstallationType;
  n: string;
  lon: number;
  lat: number;
  /** province it sits in */
  p: number;
  /** ports that are really just a coastal city */
  city?: number;
}

/** Cell size of the nearest-installation lookup grid, in degrees. */
const GRID_DEG = 2;
const cellKey = (lon: number, lat: number) =>
  `${Math.floor(lon / GRID_DEG)},${Math.floor(lat / GRID_DEG)}`;

export class Installations {
  readonly all: Installation[];
  /** province id -> installations in it */
  private byProvince = new Map<number, Installation[]>();
  /** grid cell -> installations in it, per type */
  private grid = new Map<string, Installation[]>();

  private constructor(all: Installation[]) {
    this.all = all;
    for (const i of all) {
      const list = this.byProvince.get(i.p) ?? [];
      list.push(i);
      this.byProvince.set(i.p, list);

      const k = `${i.t}:${cellKey(i.lon, i.lat)}`;
      const cell = this.grid.get(k) ?? [];
      cell.push(i);
      this.grid.set(k, cell);
    }
  }

  static async load(): Promise<Installations> {
    const base = import.meta.env.BASE_URL || '/';
    const data = await fetch(`${base}data/installations.json`, { cache: 'no-store' }).then((r) => r.json());
    return new Installations(data.installations as Installation[]);
  }

  in(province: number, type?: InstallationType): Installation[] {
    const list = this.byProvince.get(province) ?? [];
    return type ? list.filter((i) => i.t === type) : list;
  }

  has(province: number, type: InstallationType) { return this.in(province, type).length > 0; }

  /**
   * Closest installation of a type to a point, within `maxDeg`.
   *
   * Every air wing asks this on every simulation step, so it walks a grid of
   * the cells that could hold a closer installation rather than the whole
   * thirty thousand.
   */
  nearest(lon: number, lat: number, type: InstallationType, maxDeg = 3): Installation | null {
    let best: Installation | null = null, bestD = maxDeg * maxDeg;
    const reach = Math.ceil(maxDeg / GRID_DEG);
    const cx = Math.floor(lon / GRID_DEG), cy = Math.floor(lat / GRID_DEG);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const cell = this.grid.get(`${type}:${cx + dx},${cy + dy}`);
        if (!cell) continue;
        for (const i of cell) {
          const d = (i.lon - lon) ** 2 + (i.lat - lat) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }

  /** Provinces where a nation can base this kind of force. */
  basesOf(type: InstallationType, owner: (province: number) => boolean): Installation[] {
    return this.all.filter((i) => i.t === type && i.p >= 0 && owner(i.p));
  }

  get counts() {
    const c = { air: 0, port: 0, base: 0 };
    for (const i of this.all) c[i.t]++;
    return c;
  }
}
