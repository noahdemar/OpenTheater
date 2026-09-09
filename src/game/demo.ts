import type { Map as MapLibreMap } from 'maplibre-gl';
import { PLAN_STYLE, type PlanStore } from './plans';
import { TEMPLATES, atWar, type Scenario } from './scenario';
import type { Sim } from './sim';
import type { Division, UnitKind } from './types';
import type { World } from './world';

/**
 * A scripted set piece: a corps-scale offensive on the eastern frontier, and a
 * camera that walks the whole command ladder down to the men fighting it.
 *
 * The point is to show both ends of the scale in one continuous world - the
 * same units that appear as a single army counter over Europe are the ones
 * exchanging fire between two treelines when you get close enough.
 */

export interface Stage {
  center: [number, number] | (() => [number, number]);
  zoom: number;
  pitch: number;
  bearing?: number;
  /** how long the camera rests here, ms */
  dwell: number;
  speed: number;
  duration: number;
  /** slowly rotate the camera while resting here */
  orbit?: boolean;
}

/**
 * The theatre: the north Aegean around Lemnos.
 *
 * Deliberately small. A continental front makes a fine wide shot but nothing
 * legible up close, whereas a single contested strait can be shown whole at
 * every scale from the region down to the men on the beach.
 */
const THEATRE: [number, number] = [25.25, 39.9];
const THEATRE_RADIUS_DEG = 3.2;
/** brigades added to each frontier province, per side */
const REINFORCE = 5;
/** how many of a province's formations join the assault */
const ASSAULT_WAVE = 5;

export interface DemoHooks {
  /** called when the set piece starts and ends, to clear the working panels */
  cinematic: (on: boolean) => void;
  onSetup: (summary: string) => void;
  rebuildForces: () => void;
}

export class Demo {
  running = false;
  private timers: number[] = [];
  private pressure = 0;
  private orbit = 0;
  private contactPoint: [number, number] = THEATRE;
  private front: [number, number][] = [];

  constructor(
    private map: MapLibreMap,
    private world: World,
    private scn: Scenario,
    private sim: Sim,
    private plans: PlanStore,
    private hooks: DemoHooks,
  ) {}

  /**
   * Draw the offensive as a battle plan: a held front along the frontier and
   * the axes the attack is driving along. This is the layer that makes a wall
   * of counters read as a plan rather than a crowd.
   */
  private drawPlans(front: [number, number][]) {
    if (!front.length) return;
    const { world, scn } = this;

    // No drawn front line here: the map already renders the real one, in both
    // sides' colours. Only the axes of advance are worth adding on top.
    const attacker = scn.controller[front[0][0]];

    // Three axes of advance, spread down the front, all driven by the same
    // bloc so they read as one plan. Orienting on a single *nation* fails: a
    // front of this length runs across several allied countries.
    const blocOf = (nation: number) => scn.factions.find((f) => f.members.includes(nation))?.id;
    const attackingBloc = blocOf(attacker);
    const picks = [0.2, 0.5, 0.8]
      .map((f) => front[Math.floor(front.length * f)])
      .filter(Boolean)
      .map(([x, y]) => {
        const bx = blocOf(scn.controller[x]), by = blocOf(scn.controller[y]);
        if (attackingBloc && bx === attackingBloc) return [x, y] as [number, number];
        if (attackingBloc && by === attackingBloc) return [y, x] as [number, number];
        return null;      // neither side is ours: an arrow here would point nowhere
      })
      .filter((pair): pair is [number, number] => !!pair);

    for (const [from, to] of picks) {
      const a = world.province(from), b = world.province(to);
      this.plans.start('invasion', scn.controller[from]);
      this.plans.addPoint(a.lon, a.lat);
      this.plans.addPoint(b.lon, b.lat);

      // Carry the axis into their depth only if there is depth to carry it
      // into: an extrapolated head can otherwise end up out at sea or back on
      // our own ground.
      const deeper = b.nb.find((n) => n !== from
        && scn.controller[n] === scn.controller[to]
        && world.province(n).nb.length > 1);
      if (deeper !== undefined) {
        const head = world.province(deeper);
        this.plans.addPoint(head.lon, head.lat);
      }
      this.plans.finish();
    }
    void PLAN_STYLE;
  }

  /** Reinforce both sides along the frontier and launch the offensive. */
  /**
   * Nobody is fighting in the Aegean when the scenario opens, so the set piece
   * opens the war it is about to show: the two nations that share the most
   * frontier inside the theatre.
   */
  private ensureWar(): void {
    const { world, scn } = this;
    const near = (id: number) => {
      const p = world.province(id);
      return Math.hypot(p.lon - THEATRE[0], (p.lat - THEATRE[1]) * 1.6) < THEATRE_RADIUS_DEG;
    };
    const shared = new Map<string, number>();
    for (const [key] of world.borders) {
      const [a, b] = key.split(':').map(Number);
      if (!near(a) || !near(b)) continue;
      const ca = scn.controller[a], cb = scn.controller[b];
      if (ca === cb) continue;
      const pair = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
      shared.set(pair, (shared.get(pair) ?? 0) + 1);
    }
    const ranked = [...shared].sort((x, y) => y[1] - x[1]);
    for (const [pair] of ranked) {
      const [a, b] = pair.split(':').map(Number);
      if (atWar(scn, a, b)) return;                 // a war is already running here
    }
    if (!ranked.length) return;
    const [a, b] = ranked[0][0].split(':').map(Number);
    scn.wars.add(a < b ? `${a}:${b}` : `${b}:${a}`);
  }

  private setup(): { brigades: number; battles: number; frontKm: number } {
    const { world, scn } = this;
    this.ensureWar();
    const near = (id: number) => {
      const p = world.province(id);
      return Math.hypot(p.lon - THEATRE[0], (p.lat - THEATRE[1]) * 1.6) < THEATRE_RADIUS_DEG;
    };

    // the contested border in this theatre
    const front: [number, number][] = [];
    for (const [key] of world.borders) {
      const [a, b] = key.split(':').map(Number);
      if (!near(a) || !near(b)) continue;
      if (!atWar(scn, scn.controller[a], scn.controller[b])) continue;
      front.push([a, b]);
    }

    let nextId = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;
    const added: Division[] = [];
    const kinds: UnitKind[] = ['mechanised', 'armoured', 'light', 'airborne', 'mechanised', 'light'];
    const reinforce = (province: number, n: number, seed: number) => {
      for (let i = 0; i < n; i++) {
        const kind = kinds[(seed + i) % kinds.length];
        added.push({
          id: nextId++,
          owner: scn.controller[province],
          template: kind,
          name: `${(seed % 40) + 1} ${TEMPLATES[kind].name}`,
          province,
          pos: [this.world.province(province).lon, this.world.province(province).lat],
          strength: 0.9 + ((seed + i) % 10) / 100,
          org: 0.85 + ((seed + i) % 12) / 100,
          experience: 0.15,
          path: [],
          progress: 0,
          attacking: null,
          entrenchment: 0.35,
        });
      }
    };

    // pack the frontier provinces on both sides
    const seen = new Set<number>();
    let seed = 1;
    for (const [a, b] of front) {
      for (const p of [a, b]) {
        if (seen.has(p)) continue;
        seen.add(p);
        reinforce(p, REINFORCE, seed++);
      }
    }
    for (const d of added) { this.scn.divisions.push(d); this.sim.byId.set(d.id, d); }
    this.hooks.rebuildForces();

    // every formation on the frontier attacks straight across it
    let attacks = 0;
    const contact: [number, number][] = [];
    for (const [a, b] of front) {
      const attackerSide = scn.controller[a];
      const attackers = scn.divisions.filter((d) => d.province === a && d.owner === attackerSide);
      if (!attackers.length) continue;
      this.sim.order(attackers.slice(0, ASSAULT_WAVE), b);
      attacks += Math.min(ASSAULT_WAVE, attackers.length);
      const pa = world.province(a), pb = world.province(b);
      contact.push([(pa.lon + pb.lon) / 2, (pa.lat + pb.lat) / 2]);
    }

    if (contact.length) {
      // aim the camera at the middle of the contested frontier
      const mid = contact[Math.floor(contact.length / 2)];
      this.contactPoint = mid;
    }

    this.front = front;
    this.drawPlans(front);
    const frontKm = front.reduce((s, [a, b]) => s + world.distance(a, b), 0);
    return { brigades: added.length, battles: attacks, frontKm: Math.round(frontKm) };
  }

  /**
   * Where the shooting actually is: the midpoint of the border two provinces
   * share, taken from a live battle. Resolved when the stage fires, so the
   * close-in shots land on a firing line rather than a province centroid.
   */
  /**
   * Where the fighting is thickest.
   *
   * Targeting one battle is unreliable for the close-in shots: a battle can end
   * during the three seconds the camera takes to fly there, leaving an empty
   * field. This picks the stretch of frontier with the most formations packed
   * around it and then holds that point for the rest of the sequence, so the
   * camera always lands on troops.
   */
  private closeFocus: [number, number] | null = null;
  /** the battle the close-in shots are following */
  private focusBattle: number | null = null;

  /** How many formations are packed around a point. */
  private unitsNear(at: [number, number], radius = 0.55): number {
    let n = 0;
    for (const d of this.scn.divisions) {
      const dx = (d.pos[0] - at[0]) * 0.62, dy = d.pos[1] - at[1];
      if (dx * dx + dy * dy < radius * radius) n += d.attacking !== null ? 3 : 1;
    }
    return n;
  }

  /**
   * Where the close-in shots point.
   *
   * A battle's brigades deploy onto the border between the two provinces, so
   * the midpoint of that border is exactly where the troops are - which a
   * "densest region" heuristic is not, at a zoom where the view is a tenth of
   * a degree across. The chosen battle is held while it lasts so the camera
   * does not hop between shots.
   */
  private contactFocus = (): [number, number] => {
    const { sim, world } = this;
    const inTheatre = (province: number) => {
      const p = world.province(province);
      return Math.hypot(p.lon - THEATRE[0], (p.lat - THEATRE[1]) * 1.6) < THEATRE_RADIUS_DEG;
    };
    const borderMid = (battle: { province: number; attackers: number[] }): [number, number] | null => {
      const attacker = sim.byId.get(battle.attackers[0]);
      if (!attacker) return null;
      const segs = world.borders.get(world.borderKey(attacker.province, battle.province));
      if (segs?.length) {
        const mid = segs[Math.floor(segs.length / 2)];
        return [(mid[0][0] + mid[1][0]) / 2, (mid[0][1] + mid[1][1]) / 2];
      }
      const p = world.province(battle.province);
      return [p.lon, p.lat];
    };

    // stay with the battle we are already watching, while it is still being fought
    if (this.focusBattle !== null) {
      const still = sim.battles.get(this.focusBattle);
      if (still && still.attackers.length) {
        const at = borderMid(still);
        if (at) { this.closeFocus = at; return at; }
      }
    }

    const candidates = [...sim.battles.values()]
      .filter((b) => inTheatre(b.province) && b.attackers.length && b.defenders.length)
      .sort((a, b) => (b.attackers.length + b.defenders.length) - (a.attackers.length + a.defenders.length));
    for (const battle of candidates) {
      const at = borderMid(battle);
      if (!at) continue;
      this.focusBattle = battle.province;
      this.closeFocus = at;
      return at;
    }
    return this.closeFocus ?? this.contactPoint;
  };

  private denseFocus = (): [number, number] => {
    // hold the previous point while it still has troops on it; the front moves
    // during the sequence and a stale focus lands the camera on empty fields
    if (this.closeFocus && this.unitsNear(this.closeFocus) >= 8) return this.closeFocus;
    const previous = this.closeFocus;
    const { scn, world } = this;
    const inTheatre = (lon: number, lat: number) =>
      Math.hypot(lon - THEATRE[0], (lat - THEATRE[1]) * 1.6) < THEATRE_RADIUS_DEG;

    // candidate points: the contested borders of this theatre
    const candidates: [number, number][] = [];
    for (const [a, b] of this.front) {
      const pa = world.province(a), pb = world.province(b);
      const mid: [number, number] = [(pa.lon + pb.lon) / 2, (pa.lat + pb.lat) / 2];
      if (inTheatre(mid[0], mid[1])) candidates.push(mid);
    }
    if (!candidates.length) return this.contactPoint;

    // Re-targeting must stay local. Jumping to the densest point anywhere in
    // the theatre sends the camera on a continent-wide arc between shots.
    const reachable = previous
      ? candidates.filter((c) => Math.hypot((c[0] - previous[0]) * 0.62, c[1] - previous[1]) < 2.5)
      : candidates;
    const pool = reachable.length ? reachable : candidates;

    let best = pool[0], bestScore = -1;
    for (const c of pool) {
      const score = this.unitsNear(c, 0.4);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    void scn;
    this.closeFocus = best;
    return best;
  };

  private battleFocus = (): [number, number] => {
    // only battles in this theatre: wars now run worldwide, and the camera
    // must not jump to another continent between shots
    const battles = [...this.sim.battles.values()].filter((b) => {
      const p = this.world.province(b.province);
      return Math.hypot(p.lon - THEATRE[0], (p.lat - THEATRE[1]) * 1.6) < THEATRE_RADIUS_DEG;
    });
    if (!battles.length) return this.contactPoint;
    // prefer a fight with the most units in it, so there is something to watch
    battles.sort((a, b) => (b.attackers.length + b.defenders.length) - (a.attackers.length + a.defenders.length));
    const battle = battles[0];
    const attacker = this.sim.byId.get(battle.attackers[0]);
    if (attacker) {
      const segs = this.world.borders.get(this.world.borderKey(attacker.province, battle.province));
      if (segs?.length) {
        const mid = segs[Math.floor(segs.length / 2)];
        return [(mid[0][0] + mid[1][0]) / 2, (mid[0][1] + mid[1][1]) / 2];
      }
    }
    const p = this.world.province(battle.province);
    return [p.lon, p.lat];
  };

  /** Middle of the contested frontier, for the wide shots. */
  private frontCentre(): [number, number] {
    if (!this.front.length) return THEATRE;
    let lon = 0, lat = 0;
    for (const [a] of this.front) {
      const p = this.world.province(a);
      lon += p.lon; lat += p.lat;
    }
    return [lon / this.front.length, lat / this.front.length];
  }

  private stages(): Stage[] {
    return [
      {
        center: () => this.frontCentre(),
        zoom: 6.4, pitch: 0, dwell: 4200, speed: 3, duration: 2600,
      },
      {
        center: () => this.frontCentre(), zoom: 7.4, pitch: 0, bearing: 0, dwell: 4600, speed: 2, duration: 2600,
      },
      {
        center: () => { const f = this.battleFocus(); return [f[0] - 1.2, f[1] + 0.4]; },
        zoom: 8.4, pitch: 0, bearing: -8, dwell: 4200, speed: 3, duration: 3200,
      },
      {
        center: this.denseFocus, zoom: 10.2, pitch: 25, bearing: -14, dwell: 5200, speed: 2, duration: 3200,
      },
      {
        center: this.contactFocus, zoom: 11.6, pitch: 40, bearing: -22, dwell: 5200, speed: 1, duration: 3200,
      },
      {
        center: this.contactFocus, zoom: 13.2, pitch: 55, bearing: -30, dwell: 10000, speed: 1, duration: 3400, orbit: true,
      },
      {
        center: this.contactFocus, zoom: 14.6, pitch: 62, bearing: -46, dwell: 12000, speed: 1, duration: 3200, orbit: true,
      },
    ];
  }

  /**
   * Keep feeding the attack. Without this the offensive burns out in a couple
   * of game days and the camera arrives at an empty field.
   */
  private keepPressure() {
    const { scn } = this;
    for (const [a, b] of this.front) {
      for (const [from, to] of [[a, b], [b, a]] as [number, number][]) {
        const side = scn.controller[from];
        if (!atWar(scn, side, scn.controller[to])) continue;
        const idle = scn.divisions.filter((d) =>
          d.province === from && d.owner === side && !d.route && d.attacking === null && d.org > 0.35);
        if (idle.length) this.sim.order(idle.slice(0, 2), to);
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.closeFocus = null;
    this.focusBattle = null;
    this.hooks.cinematic(true);
    const summary = this.setup();
    this.pressure = window.setInterval(() => {
      if (this.running) this.keepPressure();
    }, 2500);
    this.hooks.onSetup(
      `${summary.brigades} brigades committed · ${summary.battles} attacks · ${summary.frontKm} km front`);

    const stages = this.stages();
    let t = 0;
    for (const stage of stages) {
      this.timers.push(window.setTimeout(() => {
        if (!this.running) return;
        this.sim.speed = stage.speed;
        this.map.flyTo({
          center: typeof stage.center === 'function' ? stage.center() : stage.center,
          zoom: stage.zoom,
          pitch: stage.pitch,
          bearing: stage.bearing ?? 0,
          duration: stage.duration,
          essential: true,
          curve: 1.3,
        });
        // A slow orbit at the close, started only once the flight has landed:
        // touching the camera mid-flyTo cancels the flight outright.
        if (this.orbit) { clearInterval(this.orbit); this.orbit = 0; }
        if (stage.orbit) {
          this.timers.push(window.setTimeout(() => {
            if (!this.running) return;
            const spin = window.setInterval(() => {
              if (!this.running) { clearInterval(spin); return; }
              this.map.setBearing(this.map.getBearing() + 0.1);
            }, 40);
            this.orbit = spin;
            this.timers.push(spin);
          }, stage.duration + 250));
        }
      }, t));
      t += stage.duration + stage.dwell;
    }
    this.timers.push(window.setTimeout(() => {
      this.hooks.cinematic(false);
      if (this.pressure) { clearInterval(this.pressure); this.pressure = 0; }
      if (this.orbit) { clearInterval(this.orbit); this.orbit = 0; }
      this.running = false;
    }, t));
  }

  stop() {
    this.running = false;
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
    if (this.pressure) { clearInterval(this.pressure); this.pressure = 0; }
    if (this.orbit) { clearInterval(this.orbit); this.orbit = 0; }
    this.map.easeTo({ bearing: 0, pitch: 0, duration: 900 });
    this.hooks.cinematic(false);
  }
}
