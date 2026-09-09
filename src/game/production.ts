import { TEMPLATES } from './scenario';
import type { Scenario } from './scenario';
import { bonus } from './tech';
import type { Division, UnitKind } from './types';

/**
 * Industry, kept deliberately simple.
 *
 * Factories turn out equipment; equipment is spent two ways - building new
 * formations, and replacing what worn-down formations have lost. A nation that
 * builds constantly cannot also reinforce, which is the only trade-off the
 * model needs to be interesting.
 */

/** Equipment cost of one formation. */
export const COST: Record<string, number> = {
  territorial: 45,
  light: 70,
  airborne: 100,
  marine: 105,
  mechanised: 130,
  armoured: 200,
  airwing: 240,
  flotilla: 280,
  orbital: 420,
};

/** What a player can put in the queue, in the order they are offered. */
export const BUILDABLE: UnitKind[] = [
  'light', 'mechanised', 'armoured', 'airborne', 'marine', 'territorial',
  'airwing', 'flotilla', 'orbital',
];

export interface BuildOrder {
  id: number;
  template: UnitKind;
  /** equipment already sunk into it */
  progress: number;
  cost: number;
}

export interface NationIndustry {
  stockpile: number;
  queue: BuildOrder[];
  /** province new formations appear in */
  deploy: number;
}

export class Production {
  readonly byNation = new Map<number, NationIndustry>();
  private nextOrder = 1;
  private nextDivision: number;

  private capitalOf: (nation: number) => number;

  constructor(private scn: Scenario, capitalOf: (nation: number) => number) {
    this.capitalOf = capitalOf;
    this.nextDivision = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;
    this.reseed(scn);
  }

  /** Give every nation an industry, after the world has been rebuilt. */
  reseed(scn: Scenario) {
    this.byNation.clear();
    this.nextDivision = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;
    for (const [id] of scn.nations) {
      this.byNation.set(id, { stockpile: 60, queue: [], deploy: this.capitalOf(id) });
    }
  }

  /** A single nation joining an existing world, from the editor. */
  addNation(id: number) {
    if (this.byNation.has(id)) return;
    this.byNation.set(id, { stockpile: 60, queue: [], deploy: this.capitalOf(id) });
  }

  /** Equipment produced per day. */
  rate(nation: number): number {
    const n = this.scn.nations.get(nation);
    if (!n) return 0;
    return n.factories * 1.4 * bonus(n.techs, 'production');
  }

  industry(nation: number): NationIndustry {
    return this.byNation.get(nation)!;
  }

  queue(nation: number, template: UnitKind) {
    const ind = this.byNation.get(nation);
    if (!ind || ind.queue.length >= 12) return;
    ind.queue.push({ id: this.nextOrder++, template, progress: 0, cost: COST[template] });
  }

  cancel(nation: number, orderId: number) {
    const ind = this.byNation.get(nation);
    if (!ind) return;
    const i = ind.queue.findIndex((o) => o.id === orderId);
    if (i < 0) return;
    ind.stockpile += ind.queue[i].progress * 0.5;    // half the equipment is recovered
    ind.queue.splice(i, 1);
  }

  /**
   * @param days elapsed game days
   * @param deployed called with each newly built formation
   */
  tick(days: number, at: (province: number) => [number, number], deployed?: (d: Division) => void) {
    for (const [id, ind] of this.byNation) {
      const nation = this.scn.nations.get(id);
      if (!nation) continue;
      ind.stockpile += this.rate(id) * days;

      // replacements come first: a formation in the field is worth more than
      // one still on the drawing board
      const understrength = this.scn.divisions.filter((d) => d.owner === id && d.strength < 0.99);
      if (understrength.length && ind.stockpile > 0) {
        const budget = Math.min(ind.stockpile, this.rate(id) * days * 0.5);
        const per = budget / understrength.length;
        let spent = 0;
        for (const d of understrength) {
          const need = (1 - d.strength) * COST[d.template];
          const use = Math.min(per, need);
          d.strength = Math.min(1, d.strength + use / COST[d.template]);
          spent += use;
        }
        ind.stockpile -= spent;
      }

      // then the build queue, one formation at a time
      const order = ind.queue[0];
      if (!order || ind.stockpile <= 0) continue;
      const put = Math.min(ind.stockpile, this.rate(id) * days, order.cost - order.progress);
      order.progress += put;
      ind.stockpile -= put;
      if (order.progress >= order.cost) {
        ind.queue.shift();
        const division = this.build(id, order.template, ind.deploy, at);
        deployed?.(division);
      }
    }
  }

  private build(owner: number, template: UnitKind, province: number, at: (p: number) => [number, number]): Division {
    const d: Division = {
      id: this.nextDivision++,
      owner,
      template,
      name: `${this.nextDivision % 90} ${TEMPLATES[template].name}`,
      province,
      pos: at(province),
      strength: 0.65,          // arrives short of establishment and fills out
      org: 0.5,
      experience: 0,
      path: [],
      progress: 0,
      attacking: null,
      entrenchment: 0,
      route: null,
      target: null,
    };
    this.scn.divisions.push(d);
    return d;
  }
}
