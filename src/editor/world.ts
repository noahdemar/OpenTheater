import { applyOrderOfBattle, buildScenario, garrisonBases, type OobUnit, type Scenario } from '../game/scenario';
import type { Sim } from '../game/sim';
import type { ArmyStore } from '../game/armies';
import type { PlanStore } from '../game/plans';
import type { Production } from '../game/production';
import type { Installations } from '../game/installations';
import type { WorldData } from '../game/types';

/**
 * Wiping and rebuilding the world.
 *
 * The editor can only add to a world; sometimes you want to start from nothing
 * and build the whole thing yourself, and then get back to the shipped
 * scenario without reloading the page.
 */

/** Sentinel for ground that belongs to nobody. */
export const NO_NATION = -1;

export interface WorldParts {
  scn: Scenario;
  sim: Sim;
  armies: ArmyStore;
  plans: PlanStore;
  production: Production;
}

/** Strip everything: no nations, no armies, no owned ground, no wars. */
export function clearWorld({ scn, sim, armies, plans, production }: WorldParts): void {
  scn.divisions.length = 0;
  sim.byId.clear();
  sim.battles.clear();
  sim.air?.missions.clear();
  sim.air?.bases.clear();
  sim.speed = 0;

  scn.owner.fill(NO_NATION);
  scn.controller.fill(NO_NATION);
  scn.nations.clear();
  scn.wars.clear();
  scn.peaceOffers.clear();
  scn.victoryPoints.clear();
  for (const f of scn.factions) f.members.length = 0;

  armies.armies = [];
  plans.plans = [];
  plans.cancel();
  production.byNation.clear();
}

/**
 * Put the shipped 2026 scenario back, in place, so every reference the running
 * game holds to the scenario object stays valid.
 */
export function resetWorld(
  parts: WorldParts,
  data: WorldData,
  installations: Installations,
  oob: OobUnit[],
  at: (province: number) => [number, number],
): { nations: number; divisions: number } {
  const { scn, sim, production } = parts;
  const fresh = buildScenario(data);

  clearWorld(parts);

  scn.owner.set(fresh.owner);
  scn.controller.set(fresh.controller);
  for (const [id, nation] of fresh.nations) scn.nations.set(id, nation);
  for (const w of fresh.wars) scn.wars.add(w);
  for (const [p, v] of fresh.victoryPoints) scn.victoryPoints.set(p, v);
  for (const f of fresh.factions) {
    const target = scn.factions.find((x) => x.id === f.id);
    if (target) target.members.push(...f.members);
  }
  scn.divisions.push(...fresh.divisions);

  garrisonBases(
    scn,
    installations.all.filter((i) => i.t === 'air'),
    installations.all.filter((i) => i.t === 'port'),
    at,
  );
  if (oob.length) applyOrderOfBattle(scn, oob);

  for (const d of scn.divisions) sim.byId.set(d.id, d);
  sim.date = new Date(Date.UTC(2026, 0, 1));
  production.reseed(scn);

  return { nations: scn.nations.size, divisions: scn.divisions.length };
}
