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
const THEATRE: [number, number] = [25.23, 39.905];

/**
 * Real places on Lemnos, because the map is real.
 *
 * The island is about 30 km across, which is smaller than one province cell:
 * a province-level front cannot happen here, and the border the engine would
 * otherwise put a battle on lies out in the Aegean. So the set piece places
 * its troops at these points itself and tells the map where the line is.
 */
const LEMNOS = {
  /** the harbour town on the west coast, and the objective */
  myrina: [25.060, 39.874] as [number, number],
  /** the great natural harbour on the east side: the landing */
  moudros: [25.271, 39.883] as [number, number],
  /** the airfield on the north-east of the island */
  airfield: [25.236, 39.917] as [number, number],
  /** the north-west coast */
  kaspakas: [25.030, 39.952] as [number, number],
  /** the neck of high ground the defence holds, between the two coasts */
  line: 25.163,
};
/** everything the set piece looks at is inside this much of the island */
const ISLAND_REACH_DEG = 0.34;
/** north and south ends of the island, for laying the line out */
const ISLAND_N = 39.985;
const ISLAND_S = 39.815;
/** brigades on each side of the island fight */
const REINFORCE = 6;

export interface DemoHooks {
  /** called when the set piece starts and ends, to clear the working panels */
  cinematic: (on: boolean) => void;
  onSetup: (summary: string) => void;
  rebuildForces: () => void;
  /**
   * Tell the map where the firing line is. The island is smaller than the
   * province it sits in, so the border the engine would otherwise deploy on
   * lies out at sea.
   */
  setContacts: (contacts: Map<number, { lon: number; lat: number; ax: number; ay: number }> | null) => void;
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
   * The two sides.
   *
   * The island belongs to whoever holds the province it sits in; the assault
   * comes from the nearest neighbouring province in other hands. If the two
   * are not already at war, the set piece opens one - that is what it is here
   * to show.
   */
  private sides(): { island: number; invader: number; defender: number; attacker: number } | null {
    const { world, scn } = this;
    const island = world.provinceAt(THEATRE[0], THEATRE[1]);
    if (island < 0) return null;
    const defender = scn.controller[island];

    let invader = -1;
    for (const nb of world.province(island).nb) {
      if (scn.controller[nb] !== defender) { invader = nb; break; }
    }
    if (invader < 0) return null;
    const attacker = scn.controller[invader];
    if (!atWar(scn, defender, attacker)) {
      scn.wars.add(defender < attacker ? `${defender}:${attacker}` : `${attacker}:${defender}`);
    }
    return { island, invader, defender, attacker };
  }

  /** A brigade, placed exactly where the script wants it. */
  private raise(
    owner: number, province: number, at: [number, number], kind: UnitKind, name: string, seed: number,
  ): Division {
    return {
      id: this.nextId++,
      owner,
      template: kind,
      name,
      province,
      pos: [at[0], at[1]],
      strength: 0.9 + (seed % 10) / 100,
      org: 0.85 + (seed % 12) / 100,
      experience: 0.15,
      path: [],
      progress: 0,
      attacking: null,
      entrenchment: 0.35,
    };
  }

  private nextId = 1;

  /**
   * The landing on Lemnos.
   *
   * Two lines drawn across the island: the defence holding the neck of high
   * ground that separates Myrina from the bay at Moudros, and the landing
   * force pushing west off the beaches. Both are laid out at real coordinates
   * on the real island, and the map is told where the line is, because the
   * province the island sits inside is bigger than the island.
   */
  private setup(): { brigades: number; battles: number; frontKm: number } {
    const { scn } = this;
    const sides = this.sides();
    if (!sides) return { brigades: 0, battles: 0, frontKm: 0 };
    const { island, invader, defender, attacker } = sides;

    this.nextId = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;
    const defKinds: UnitKind[] = ['mechanised', 'light', 'territorial', 'mechanised', 'light', 'armoured'];
    const atkKinds: UnitKind[] = ['marine', 'marine', 'airborne', 'armoured', 'mechanised', 'marine'];

    const added: Division[] = [];
    const defenders: Division[] = [];
    const attackers: Division[] = [];
    const line: { d: Division; at: [number, number]; facing: number }[] = [];

    // spread both lines from the north of the island to the south
    for (let i = 0; i < REINFORCE; i++) {
      const t = i / Math.max(1, REINFORCE - 1);
      const lat = ISLAND_N - (ISLAND_N - ISLAND_S) * t;
      // the defence sits just west of the neck, the landing force just east
      const dPos: [number, number] = [LEMNOS.line - 0.012, lat];
      const aPos: [number, number] = [LEMNOS.line + 0.012, lat];
      const dv = this.raise(defender, island, dPos, defKinds[i % defKinds.length],
        `${i + 1} ${TEMPLATES[defKinds[i % defKinds.length]].name}`, i + 3);
      const av = this.raise(attacker, invader, aPos, atkKinds[i % atkKinds.length],
        `${i + 1} ${TEMPLATES[atkKinds[i % atkKinds.length]].name}`, i + 11);
      defenders.push(dv); attackers.push(av);
      added.push(dv, av);
      line.push({ d: dv, at: dPos, facing: 1 }, { d: av, at: aPos, facing: -1 });
    }

    for (const d of added) { scn.divisions.push(d); this.sim.byId.set(d.id, d); }
    this.hooks.rebuildForces();

    // the landing force is already ashore: it fights where it stands
    this.sim.assault(attackers, island);

    // and the map is told the line runs down the island, not out to sea
    this.hooks.setContacts(new Map(line.map(({ d, at, facing }) =>
      [d.id, { lon: at[0], lat: at[1], ax: 0, ay: facing }])));

    this.contactPoint = [LEMNOS.line, (ISLAND_N + ISLAND_S) / 2];
    this.front = [[island, invader]];
    this.drawLandingPlan(attacker);

    const frontKm = (ISLAND_N - ISLAND_S) * 111;
    return { brigades: added.length, battles: attackers.length, frontKm: Math.round(frontKm) };
  }

  /**
   * The plan: the beachhead at Moudros and the drive west on Myrina, with a
   * second axis north to the airfield.
   */
  private drawLandingPlan(attacker: number) {
    this.plans.plans = this.plans.plans.filter((p) => p.owner !== attacker);
    const axis = (points: [number, number][]) => {
      this.plans.start('invasion', attacker);
      for (const [lon, lat] of points) this.plans.addPoint(lon, lat);
      this.plans.finish();
    };
    axis([LEMNOS.moudros, [LEMNOS.line, 39.878], LEMNOS.myrina]);
    axis([[LEMNOS.moudros[0], 39.905], LEMNOS.airfield]);
    void PLAN_STYLE;
  }

  /**
   * Where the shooting actually is: the midpoint of the border two provinces
   * share, taken from a live battle. Resolved when the stage fires, so the
   * close-in shots land on a firing line rather than a province centroid.
   */
  /** the point the close-in shots are holding */
  private closeFocus: [number, number] | null = null;


  /**
   * Where the close-in shots point.
   *
   * The line the set piece staged is the line the troops are on, so the camera
   * follows the middle of the formations actually in contact rather than the
   * province border - which, for an island inside a much larger cell, is out
   * in the Aegean.
   */
  private contactFocus = (): [number, number] => {
    const engaged = this.scn.divisions.filter((d) =>
      d.attacking !== null
      && Math.hypot(d.pos[0] - THEATRE[0], (d.pos[1] - THEATRE[1]) * 1.6) < ISLAND_REACH_DEG);
    if (!engaged.length) return this.closeFocus ?? this.contactPoint;
    let lon = 0, lat = 0;
    for (const d of engaged) { lon += d.pos[0]; lat += d.pos[1]; }
    const at: [number, number] = [lon / engaged.length, lat / engaged.length];
    this.closeFocus = at;
    return at;
  };



  private stages(): Stage[] {
    const mid: [number, number] = [LEMNOS.line, (ISLAND_N + ISLAND_S) / 2];
    return [
      // the north Aegean, to place the island
      { center: THEATRE, zoom: 8.6, pitch: 0, dwell: 3600, speed: 3, duration: 2600 },
      // the whole of Lemnos: both coasts, the bay, and the line between them
      { center: mid, zoom: 10.4, pitch: 20, bearing: -6, dwell: 4200, speed: 3, duration: 2800 },
      // the beachhead at Moudros
      { center: LEMNOS.moudros, zoom: 12.4, pitch: 45, bearing: -18, dwell: 4600, speed: 2, duration: 3000 },
      // the firing line across the neck of the island
      { center: this.contactFocus, zoom: 13.8, pitch: 55, bearing: -26, dwell: 6000, speed: 1, duration: 3200, orbit: true },
      { center: this.contactFocus, zoom: 15.2, pitch: 60, bearing: -36, dwell: 7000, speed: 1, duration: 3200, orbit: true },
      // Myrina: past the 3D building threshold, among the houses of the town
      // the landing is driving on
      { center: LEMNOS.myrina, zoom: 16.4, pitch: 66, bearing: -52, dwell: 9000, speed: 1, duration: 3400, orbit: true },
      { center: LEMNOS.myrina, zoom: 17.4, pitch: 72, bearing: -68, dwell: 11000, speed: 1, duration: 3200, orbit: true },
    ];
  }

  /**
   * Keep feeding the attack. Without this the offensive burns out in a couple
   * of game days and the camera arrives at an empty field.
   */
  private keepPressure() {
    const { scn } = this;
    const [island, invader] = this.front[0] ?? [];
    if (island === undefined) return;
    // Anyone ashore who has fallen out of the fight rejoins it where they
    // stand. Ordering them to a province would march them off the island: the
    // whole battle is inside one cell.
    const ashore = scn.divisions.filter((d) =>
      (d.province === island || d.province === invader)
      && d.attacking === null && !d.route && d.org > 0.35
      && Math.hypot(d.pos[0] - THEATRE[0], (d.pos[1] - THEATRE[1]) * 1.6) < ISLAND_REACH_DEG);
    const attackers = ashore.filter((d) => d.province === invader);
    if (attackers.length) this.sim.assault(attackers, island);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.closeFocus = null;
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
