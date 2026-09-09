import { START_DATE, TEMPLATES, atWar, type Scenario } from './scenario';
import { bonus } from './tech';
import { subunitSpeed, type Subunit } from './subunits';
import { BASED_AT, TERRAIN, type Division } from './types';
import type { AirOperations } from './air';
import type { World } from './world';
import { pointAlong, polylineKm, type RoadNetwork } from './roads';

export interface Battle {
  province: number;
  attackers: number[];    // division ids
  defenders: number[];
  attackerSide: number;   // nation id leading the attack
  defenderSide: number;
  progress: number;       // -1 defender winning .. +1 attacker winning
  days: number;
}

export interface SimEvents {
  onProvinceCaptured?: (province: number, from: number, to: number) => void;
  onStrike?: (province: number, unitsHit: number) => void;
  onBattleStart?: (b: Battle) => void;
  onBattleEnd?: (b: Battle, attackerWon: boolean) => void;
}

const HOURS_PER_DAY = 24;
/** Hours a formation takes to reach its march rate from a standing start. */
const SPIN_UP_HOURS = 7;
/** Hours a halted formation takes to close up and settle. */
const SPIN_DOWN_HOURS = 5;

/** The game clock and everything that moves under it. */
export class Sim {
  date = new Date(START_DATE);
  speed = 0;                       // 0 paused, 1..5
  private carry = 0;               // fractional hours not yet applied
  readonly battles = new Map<number, Battle>();
  readonly byId = new Map<number, Division>();
  /**
   * Sub-units are derived from their brigade, so this only holds the ones a
   * player has actually moved - the rest cost nothing to exist.
   */
  readonly subunits = new Map<string, { lon: number; lat: number; objective: [number, number] | null; kind: Subunit['kind'] }>();

  /** set once the road graph has loaded; movement follows roads when it can */
  roads: RoadNetwork | null = null;
  /** the human player's nation, whose formations take no orders from the AI */
  playerNation = -1;
  /** set once installations have loaded; wings fly from real airfields */
  air: AirOperations | null = null;
  private sinceOrders = 0;

  constructor(readonly world: World, readonly scn: Scenario, private events: SimEvents = {}) {
    for (const d of scn.divisions) this.byId.set(d.id, d);
  }

  get speedFactor() { return [0, 2, 6, 16, 40, 90][this.speed] ?? 0; }

  /** Advance the world by `dtSeconds` of wall clock at the current speed. */
  update(dtSeconds: number) {
    if (this.speed === 0) return;
    const hours = dtSeconds * this.speedFactor;
    this.carry += hours;
    // step in at most 6h slices so fast-forward stays stable
    while (this.carry > 0) {
      const step = Math.min(6, this.carry);
      this.step(step);
      this.carry -= step;
    }
  }

  private step(hours: number) {
    this.date = new Date(this.date.getTime() + hours * 3600_000);
    this.moveDivisions(hours);
    this.flyMissions(hours);
    this.moveSubunits(hours);
    this.pressFronts(hours);
    this.resolveBattles(hours);
    this.recover(hours);
    this.research(hours);
  }

  // --- movement -------------------------------------------------------------

  /**
   * March formations to an exact point on the ground.
   *
   * Movement is continuous: a formation has a position, a route it is walking,
   * and a distance covered along it. Provinces are read off that position
   * rather than being the unit of movement, so an order can be "here", not
   * "somewhere in that cell".
   */
  moveTo(divisions: Division[], target: [number, number]) {
    for (const d of divisions) {
      const route = this.buildRoute(d, target);
      d.target = target;
      d.route = route;
      d.routeKm = polylineKm(route);
      d.travelledKm = 0;
      d.progress = 0;
      d.attacking = null;
      d.path = [];
    }
  }

  /** Order to the middle of a province: the same march, aimed at its centre. */
  order(divisions: Division[], province: number) {
    const p = this.world.province(province);
    this.moveTo(divisions, [p.lon, p.lat]);
  }

  /**
   * The road a formation would take. Aircraft and ships go straight; ground
   * troops use the road network when it is not a big detour, and otherwise
   * strike out cross-country.
   */
  private buildRoute(d: Division, target: [number, number]): [number, number][] {
    const direct: [number, number][] = [d.pos, target];
    if (BASED_AT[d.template] || !this.roads) return direct;
    const road = this.roads.routeBetween(d.pos, target);
    if (!road) return direct;
    const full: [number, number][] = [d.pos, ...road, target];
    const km = polylineKm(full);
    const straight = polylineKm(direct);
    // a road is worth taking only if it is not a wild detour; the network is
    // sampled at ~6 km, so a sparse region can otherwise send a march miles out
    return km > straight * 1.8 + 25 ? direct : full;
  }

  private moveDivisions(hours: number) {
    const { world, scn } = this;
    for (const d of scn.divisions) {
      if (!d.route || d.attacking !== null || !d.routeKm) {
        // halted: the column closes up and loses the momentum it had
        if (d.momentum) d.momentum = Math.max(0, d.momentum - hours / SPIN_DOWN_HOURS);
        continue;
      }

      const tpl = TEMPLATES[d.template];
      const nation = scn.nations.get(d.owner)!;
      const terrain = TERRAIN[world.province(d.province).t];
      const based = BASED_AT[d.template];
      const onRoad = d.route.length > 2;
      const kmh = based
        ? tpl.speed
        : (tpl.speed * bonus(nation.techs, 'speed'))
          / (onRoad ? 1 + (terrain.move - 1) * 0.25 : terrain.move);

      // A column takes hours to get rolling: the head moves before the tail
      // has struck camp, and a heavier formation takes longer about it. This
      // is what makes an army feel like a mass being shifted rather than a
      // token being slid across a board.
      const spinUpHours = based ? 0.5 : SPIN_UP_HOURS * (1 + tpl.armour / 40);
      const gained = hours / spinUpHours;
      d.momentum = Math.min(1, (d.momentum ?? 0) + gained);
      // a shaken formation gets under way slowly and straggles
      const drive = (0.3 + 0.7 * d.momentum) * (0.55 + 0.45 * Math.min(1, d.org / 0.8));

      const travelled = (d.travelledKm ?? 0) + kmh * drive * hours;
      d.entrenchment = Math.max(0, d.entrenchment - (0.05 * hours) / HOURS_PER_DAY);

      if (travelled >= d.routeKm) {
        const end = d.route[d.route.length - 1];
        const province = world.provinceAt(end[0], end[1]);
        const holder = scn.controller[province];
        if (holder !== d.owner && atWar(scn, d.owner, holder) && !d.withdrawing) {
          this.beginAttack(d, province);
          continue;
        }
        d.pos = end;
        d.province = province;
        if (scn.owner[province] === d.owner && holder !== d.owner) scn.controller[province] = d.owner;
        d.route = null;
        d.target = null;
        d.routeKm = 0;
        d.travelledKm = 0;
        d.progress = 0;
        d.withdrawing = false;
        continue;
      }

      const next = pointAlong(d.route, travelled / d.routeKm);
      const province = world.provinceAt(next[0], next[1]);
      if (province !== d.province) {
        const holder = scn.controller[province];
        // A formation falling back is not attacking its way out: it is getting
        // clear, and a road that clips an enemy cell must not start a battle.
        if (holder !== d.owner && atWar(scn, d.owner, holder) && !d.withdrawing) {
          // the march stops where the enemy starts
          this.beginAttack(d, province);
          continue;
        }
        d.province = province;
        if (scn.owner[province] === d.owner && holder !== d.owner) scn.controller[province] = d.owner;
      }
      d.pos = next;
      d.travelledKm = travelled;
      d.progress = travelled / d.routeKm;
    }
  }

  /** Local manoeuvre: a battalion or company walking to where it was sent. */
  /**
   * Air sorties, and the damage they do. A strike lands halfway through its
   * sortie - out to the target, then home - and hits the organisation of
   * whatever is standing in the province underneath.
   */
  private flyMissions(hours: number) {
    if (!this.air) return;
    const wings = this.scn.divisions.filter((d) => BASED_AT[d.template] === 'air');
    for (const mission of this.air.step(hours, wings)) {
      const wing = this.byId.get(mission.division);
      if (!wing || mission.target === null) continue;
      const hit = this.scn.divisions.filter((d) =>
        d.province === mission.target && atWar(this.scn, wing.owner, d.owner));
      if (!hit.length) continue;
      const tpl = TEMPLATES[wing.template];
      const power = (tpl.softAttack + tpl.hardAttack) * wing.strength * wing.org;
      for (const d of hit) {
        d.org = Math.max(0, d.org - (power / 3000) / Math.max(1, hit.length * 0.5));
        d.strength = Math.max(0.05, d.strength - (power / 26000) / Math.max(1, hit.length));
      }
      wing.org = Math.max(0.1, wing.org - 0.12);      // sorties tire a wing
      this.events.onStrike?.(mission.target, hit.length);
    }
  }

  private moveSubunits(hours: number) {
    for (const u of this.subunits.values()) {
      if (!u.objective) continue;
      const [tLon, tLat] = u.objective;
      const mPerDegLat = 110540;
      const mPerDegLon = 111320 * Math.cos((u.lat * Math.PI) / 180);
      const dx = (tLon - u.lon) * mPerDegLon, dy = (tLat - u.lat) * mPerDegLat;
      const dist = Math.hypot(dx, dy);
      const step = subunitSpeed(u.kind) * hours;
      if (dist <= step || dist < 1) { u.lon = tLon; u.lat = tLat; u.objective = null; continue; }
      u.lon += ((dx / dist) * step) / mPerDegLon;
      u.lat += ((dy / dist) * step) / mPerDegLat;
    }
  }

  /** Send a sub-unit to a point on the ground. */
  orderSubunit(unit: Subunit, target: [number, number]) {
    const cur = this.subunits.get(unit.id);
    if (cur) { cur.objective = target; return; }
    this.subunits.set(unit.id, { lon: unit.lon, lat: unit.lat, objective: target, kind: unit.kind });
  }

  /**
   * Put formations into an attack on a province without marching them there.
   *
   * The set piece stages a landing: the troops are already ashore, so the
   * battle has to be joined where they stand rather than after a march from a
   * province centroid a hundred kilometres away.
   */
  assault(divisions: Division[], province: number) {
    for (const d of divisions) this.beginAttack(d, province);
  }

  private beginAttack(d: Division, province: number) {
    const { scn } = this;
    d.attacking = province;
    d.route = null;
    d.target = null;
    let battle = this.battles.get(province);
    if (!battle) {
      battle = {
        province,
        attackers: [],
        defenders: scn.divisions
          .filter((x) => x.province === province && x.owner === scn.controller[province])
          .map((x) => x.id),
        attackerSide: d.owner,
        defenderSide: scn.controller[province],
        progress: 0,
        days: 0,
      };
      this.battles.set(province, battle);
      this.events.onBattleStart?.(battle);
    }
    if (!battle.attackers.includes(d.id)) battle.attackers.push(d.id);
  }

  // --- combat ---------------------------------------------------------------

  private power(d: Division, attacking: boolean): number {
    const tpl = TEMPLATES[d.template];
    const nation = this.scn.nations.get(d.owner)!;
    const base = attacking
      ? (tpl.softAttack * bonus(nation.techs, 'softAttack') + tpl.hardAttack * bonus(nation.techs, 'hardAttack')) * 0.5
      : tpl.defence * bonus(nation.techs, 'defence');
    return base * d.strength * (0.4 + 0.6 * d.org) * (1 + d.experience);
  }

  private resolveBattles(hours: number) {
    const { world } = this;
    for (const battle of [...this.battles.values()]) {
      battle.days += hours / HOURS_PER_DAY;
      const attackers = battle.attackers.map((id) => this.byId.get(id)!).filter((d) => d && d.org > 0.02);
      const defenders = battle.defenders.map((id) => this.byId.get(id)!).filter((d) => d && d.org > 0.02);

      if (!attackers.length) { this.endBattle(battle, false); continue; }

      const terrain = TERRAIN[world.province(battle.province).t];
      let atk = attackers.reduce((s, d) => s + this.power(d, true), 0);
      let def = defenders.reduce((s, d) => s + this.power(d, false), 0);
      def *= 1 + terrain.defence;
      def *= 1 + defenders.reduce((s, d) => s + d.entrenchment, 0) / Math.max(1, defenders.length);
      atk *= 1 / (1 + 0.15 * Math.max(0, attackers.length - 3));  // stacking penalty

      if (!defenders.length) { this.captureProvince(battle); continue; }

      const scale = hours / HOURS_PER_DAY;
      const total = atk + def || 1;
      // Both sides bleed organisation, the weaker side faster. Kept gentle on
      // purpose: a battle should last days, long enough to be watched.
      for (const d of attackers) {
        d.org = Math.max(0, d.org - (def / total) * 0.26 * scale);
        d.strength = Math.max(0.05, d.strength - (def / total) * 0.014 * scale);
      }
      for (const d of defenders) {
        d.org = Math.max(0, d.org - (atk / total) * 0.26 * scale);
        d.strength = Math.max(0.05, d.strength - (atk / total) * 0.014 * scale);
      }
      battle.progress = Math.max(-1, Math.min(1, (atk - def) / total));

      if (defenders.every((d) => d.org <= 0.02)) this.captureProvince(battle);
      else if (attackers.every((d) => d.org <= 0.05)) this.endBattle(battle, false);
    }
  }

  private captureProvince(battle: Battle) {
    const { scn, world } = this;
    const from = scn.controller[battle.province];
    scn.controller[battle.province] = battle.attackerSide;

    // Survivors fall back to a neighbouring province they still hold - they
    // march there, they do not appear there. A beaten formation is also
    // already broken up, so it starts the withdrawal at speed rather than
    // spending hours forming a column.
    for (const id of battle.defenders) {
      const d = this.byId.get(id);
      if (!d) continue;
      const retreat = world.province(battle.province).nb
        .find((nb) => scn.controller[nb] === d.owner);
      if (retreat !== undefined) {
        const p = world.province(retreat);
        this.moveTo([d], [p.lon, p.lat]);
        d.withdrawing = true;
        d.momentum = 0.8;
      }
      d.entrenchment = 0;
    }
    // The attackers walk into the ground they have taken. Occupying a province
    // is an advance across it, not a jump to its centre.
    for (const id of battle.attackers) {
      const d = this.byId.get(id);
      if (!d) continue;
      const p = world.province(battle.province);
      d.attacking = null;
      this.moveTo([d], [p.lon, p.lat]);
      d.momentum = 0.35;                    // already moving, but disorganised
      d.entrenchment = 0;
    }
    this.battles.delete(battle.province);
    this.events.onProvinceCaptured?.(battle.province, from, battle.attackerSide);
    this.events.onBattleEnd?.(battle, true);
  }

  private endBattle(battle: Battle, attackerWon: boolean) {
    for (const id of battle.attackers) {
      const d = this.byId.get(id);
      if (d) { d.attacking = null; d.route = null; d.target = null; }
    }
    this.battles.delete(battle.province);
    this.events.onBattleEnd?.(battle, attackerWon);
  }

  // --- upkeep ---------------------------------------------------------------

  private recover(hours: number) {
    const days = hours / HOURS_PER_DAY;
    for (const d of this.scn.divisions) {
      const inBattle = d.attacking !== null || this.battles.has(d.province);
      if (inBattle) continue;
      const nation = this.scn.nations.get(d.owner)!;
      const rate = 0.18 * bonus(nation.techs, 'orgRecovery');
      d.org = Math.min(1, d.org + rate * days);
      d.strength = Math.min(1, d.strength + 0.01 * days);
      if (!d.route) {
        d.entrenchment = Math.min(1.5 * bonus(nation.techs, 'entrenchment'), d.entrenchment + 0.08 * days);
      }
    }
  }

  /**
   * Front-holding, not clumping.
   *
   * A nation at war works out which of its provinces face the enemy, then
   * spreads its formations across all of them before attacking out of any of
   * them. Left to itself the previous version funnelled everything into the
   * single weakest adjacent province, which produced one enormous pile-up and
   * an empty line either side of it.
   */
  private pressFronts(hours: number) {
    this.sinceOrders += hours;
    if (this.sinceOrders < 12) return;          // reconsider twice a day
    this.sinceOrders = 0;
    const { scn, world } = this;

    // where each nation's line runs, and who is standing on it
    const fronts = new Map<number, number[]>();
    const garrison = new Map<number, number>();
    for (let p = 0; p < scn.controller.length; p++) {
      const owner = scn.controller[p];
      if (owner < 0) continue;
      if (!world.province(p).nb.some((nb) => atWar(scn, owner, scn.controller[nb]))) continue;
      const list = fronts.get(owner) ?? [];
      list.push(p);
      fronts.set(owner, list);
    }
    if (!fronts.size) return;
    // one pass for the counts: who is standing where, and how many of them
    const strengthAt = new Map<number, number>();
    for (const d of scn.divisions) {
      garrison.set(d.province, (garrison.get(d.province) ?? 0) + 1);
      if (d.owner === scn.controller[d.province]) {
        strengthAt.set(d.province, (strengthAt.get(d.province) ?? 0) + 1);
      }
    }

    const HOLD = 2;                             // formations wanted per front province
    for (const d of scn.divisions) {
      if (d.owner === this.playerNation) continue;      // the player commands their own
      if (d.route || d.attacking !== null || d.org < 0.45 || d.strength < 0.4) continue;
      const line = fronts.get(d.owner);
      if (!line?.length) continue;

      const here = world.province(d.province);
      const onFront = line.includes(d.province);
      const holding = garrison.get(d.province) ?? 0;

      if (onFront && holding >= HOLD) {
        // this stretch is held: push at the weakest ground in front of it
        const targets = here.nb.filter((nb) => atWar(scn, d.owner, scn.controller[nb]));
        if (!targets.length) continue;
        let best = targets[0], fewest = Infinity;
        for (const t of targets) {
          const defenders = strengthAt.get(t) ?? 0;
          if (defenders < fewest) { fewest = defenders; best = t; }
        }
        this.order([d], best);
        garrison.set(d.province, holding - 1);
        continue;
      }

      if (onFront) continue;                    // already holding a thin stretch: stay

      // otherwise move up to the nearest stretch of line that is undermanned
      let target = -1, bestScore = Infinity;
      for (const p of line) {
        const held = garrison.get(p) ?? 0;
        if (held >= HOLD) continue;
        const score = world.distance(d.province, p) + held * 250;
        if (score < bestScore) { bestScore = score; target = p; }
      }
      if (target < 0) continue;
      this.order([d], target);
      garrison.set(target, (garrison.get(target) ?? 0) + 1);
    }
  }

  private research(hours: number) {
    const days = hours / HOURS_PER_DAY;
    for (const n of this.scn.nations.values()) {
      if (!n.researching) continue;
      n.researching.progress += n.research * days;
    }
  }

}
