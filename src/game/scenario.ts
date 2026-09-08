import type { Division, Faction, Nation, Template, UnitKind, WorldData } from './types';
import { rng } from './rng';

/**
 * A present-day scenario. The map is OpenStreetMap as of 2026, so the political
 * situation is contemporary too: today's borders, today's blocs.
 */

export const START_DATE = Date.UTC(2026, 0, 1);

/** Brigade-sized formations, the modern manoeuvre unit. */
/**
 * Brigade templates. `range` is effective direct fire and `artillery` the
 * organic indirect-fire reach - a rifle company trades fire across a few
 * hundred metres, a tank across three kilometres, and the brigade's guns reach
 * tens of kilometres beyond that.
 */
export const TEMPLATES: Record<string, Template> = {
  mechanised:  { kind: 'mechanised',  name: 'Mechanised Bde', manpower: 4500, softAttack: 30, hardAttack: 18, defence: 44, breakthrough: 28, armour: 12, speed: 15, organisation: 60, supplyUse: 1.8, range: 2200, artillery: 18000 },
  armoured:    { kind: 'armoured',    name: 'Armoured Bde',   manpower: 4000, softAttack: 44, hardAttack: 46, defence: 32, breakthrough: 64, armour: 34, speed: 13, organisation: 48, supplyUse: 2.6, range: 3000, artillery: 20000 },
  light:       { kind: 'light',       name: 'Motor Rifle Bde',manpower: 3800, softAttack: 24, hardAttack: 8,  defence: 38, breakthrough: 16, armour: 3,  speed: 20, organisation: 58, supplyUse: 1.2, range: 800,  artillery: 12000 },
  airborne:    { kind: 'airborne',    name: 'Air Assault Bde',manpower: 3200, softAttack: 28, hardAttack: 10, defence: 34, breakthrough: 30, armour: 2,  speed: 11, organisation: 66, supplyUse: 1.4, range: 900,  artillery: 8000 },
  marine:      { kind: 'marine',      name: 'Marine Bde',     manpower: 3600, softAttack: 30, hardAttack: 12, defence: 40, breakthrough: 24, armour: 4,  speed: 12, organisation: 62, supplyUse: 1.5, range: 1000, artillery: 10000 },
  territorial: { kind: 'territorial', name: 'Territorial Bde',manpower: 3000, softAttack: 12, hardAttack: 3,  defence: 34, breakthrough: 6,  armour: 0,  speed: 7,  organisation: 42, supplyUse: 0.6, range: 500,  artillery: 0 },
  // flies from airfields only
  airwing:     { kind: 'airwing',     name: 'Air Wing',       manpower: 1200, softAttack: 34, hardAttack: 26, defence: 14, breakthrough: 20, armour: 0,  speed: 720, organisation: 70, supplyUse: 3.0, range: 400,  artillery: 260000 },
  // sails from ports only
  flotilla:    { kind: 'flotilla',    name: 'Flotilla',       manpower: 2200, softAttack: 26, hardAttack: 30, defence: 30, breakthrough: 10, armour: 18, speed: 38,  organisation: 60, supplyUse: 2.2, range: 18000, artillery: 90000 },
  // on station above the theatre: no base, no front, global reach
  orbital:     { kind: 'orbital',     name: 'Orbital Group',  manpower: 300,  softAttack: 18, hardAttack: 22, defence: 8,  breakthrough: 12, armour: 0,  speed: 27000, organisation: 80, supplyUse: 4.0, range: 1200, artillery: 2000000 },
};

/** The six playable powers, keyed by their name in the map data. */
export const MAJORS: { country: string; tag: string; name: string; color: string; faction: string }[] = [
  { country: 'United States of America', tag: 'USA', name: 'United States', color: '#4a7fa8', faction: 'atlantic' },
  { country: 'Germany',                  tag: 'GER', name: 'Germany',       color: '#6f7d8c', faction: 'atlantic' },
  { country: 'Japan',                    tag: 'JPN', name: 'Japan',         color: '#a86f6a', faction: 'atlantic' },
  { country: 'Russia',                   tag: 'RUS', name: 'Russia',        color: '#9e4a4a', faction: 'eurasian' },
  { country: 'China',                    tag: 'CHN', name: 'China',         color: '#c2a054', faction: 'eastern' },
  { country: 'India',                    tag: 'IND', name: 'India',         color: '#5f9c72', faction: 'nonaligned' },
];

/** Bloc membership, by map-data country name. */
const MEMBERSHIP: Record<string, string[]> = {
  atlantic: [
    'United States of America', 'Canada', 'United Kingdom', 'France', 'Germany', 'Italy', 'Spain',
    'Portugal', 'Netherlands', 'Belgium', 'Luxembourg', 'Denmark', 'Norway', 'Sweden', 'Finland',
    'Iceland', 'Poland', 'Czechia', 'Slovakia', 'Hungary', 'Romania', 'Bulgaria', 'Greece',
    'Turkey', 'Estonia', 'Latvia', 'Lithuania', 'Slovenia', 'Croatia', 'Albania', 'Montenegro',
    'North Macedonia', 'Japan', 'South Korea', 'Australia', 'New Zealand', 'Ukraine',
  ],
  eurasian: [
    'Russia', 'Belarus', 'Kazakhstan', 'Kyrgyzstan', 'Tajikistan', 'Armenia', 'Iran',
    'North Korea', 'Syria',
  ],
  eastern: [
    'China', 'Pakistan', 'Laos', 'Cambodia', 'Myanmar', 'Belarus',
  ],
  nonaligned: [
    'India', 'Brazil', 'Indonesia', 'South Africa', 'Nigeria', 'Egypt', 'Mexico', 'Saudi Arabia',
    'Vietnam', 'Argentina', 'Ethiopia', 'Algeria', 'Thailand', 'Philippines', 'Bangladesh',
    'Malaysia', 'Colombia', 'Chile', 'Peru', 'Morocco', 'Kenya', 'United Arab Emirates',
  ],
};

export const FACTIONS: Faction[] = [
  { id: 'atlantic',   name: 'Atlantic Pact',    color: '#4a7fa8', members: [] },
  { id: 'eurasian',   name: 'Eurasian Union',   color: '#9e4a4a', members: [] },
  { id: 'eastern',    name: 'Eastern Sphere',   color: '#c2a054', members: [] },
  { id: 'nonaligned', name: 'Southern Compact', color: '#5f9c72', members: [] },
];

/** Who is shooting at whom when the scenario opens. */
export const WARS: [string, string][] = [
  ['atlantic', 'eurasian'],
  ['atlantic', 'eastern'],
  ['eastern', 'nonaligned'],
];

export interface Scenario {
  nations: Map<number, Nation>;
  factions: Faction[];
  owner: Int32Array;
  controller: Int32Array;
  divisions: Division[];
  victoryPoints: Map<number, number>;
  /** live state of every declared war, keyed by the two nation ids */
  wars: Set<string>;
  /** peace offers awaiting an answer, keyed the same way */
  peaceOffers: Map<string, number>;
}

/** Key for a pair of nations, order-independent. */
export const warKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th',
  '12th', '14th', '16th', '18th', '20th', '21st', '24th', '25th', '27th', '30th', '33rd',
  '36th', '40th', '42nd', '45th', '48th', '52nd'];

/** A real installation, as far as unit placement cares about one. */
export interface BaseSite { p: number; lon: number; lat: number }

export function buildScenario(data: WorldData, bases: BaseSite[] = []): Scenario {
  const rand = rng(2026);
  const nations = new Map<number, Nation>();
  const byName = new Map(data.countries.map((c) => [c.name, c]));

  const factionOf = new Map<string, string>();
  for (const [faction, members] of Object.entries(MEMBERSHIP)) {
    for (const country of members) if (!factionOf.has(country)) factionOf.set(country, faction);
  }

  for (const c of data.countries) {
    const major = MAJORS.find((m) => m.country === c.name);
    nations.set(c.id, {
      id: c.id,
      name: major?.name ?? c.name,
      tag: major?.tag ?? c.name.slice(0, 3).toUpperCase(),
      color: major?.color ?? c.color,
      faction: factionOf.get(c.name) ?? null,
      playable: !!major,
      research: major ? 4 : 1,
      manpower: 0,
      factories: 0,
      techs: new Set(),
      researching: null,
    });
  }

  const factions = FACTIONS.map((f) => ({ ...f, members: [] as number[] }));
  for (const [country, faction] of factionOf) {
    const c = byName.get(country);
    if (!c) continue;                       // a bloc member the map data does not name
    factions.find((f) => f.id === faction)!.members.push(c.id);
  }

  const owner = new Int32Array(data.provinces.length);
  const controller = new Int32Array(data.provinces.length);
  for (const p of data.provinces) { owner[p.id] = p.c; controller[p.id] = p.c; }

  for (const p of data.provinces) {
    const n = nations.get(p.c);
    if (!n) continue;
    n.manpower += Math.round(p.a * (p.t === 'urban' ? 900 : p.t === 'plains' ? 420 : 180));
    n.factories += p.t === 'urban' ? 3 : p.t === 'plains' ? 1 : 0;
  }

  const divisions: Division[] = [];
  let nextId = 1;
  const byCountry = new Map<number, number[]>();
  for (const p of data.provinces) {
    const list = byCountry.get(p.c) ?? [];
    list.push(p.id);
    byCountry.set(p.c, list);
  }

  // army bases, indexed by the nation that owns the ground they stand on
  const basesOf = new Map<number, BaseSite[]>();
  for (const b of bases) {
    if (b.p < 0 || b.p >= data.provinces.length) continue;
    const cid = data.provinces[b.p].c;
    const list = basesOf.get(cid) ?? [];
    list.push(b);
    basesOf.set(cid, list);
  }

  for (const [cid, provs] of byCountry) {
    const nation = nations.get(cid)!;
    const isMajor = nation.playable;
    const aligned = !!nation.faction;
    const count = isMajor ? Math.min(30, Math.max(12, Math.round(provs.length * 0.38)))
      : aligned ? Math.max(2, Math.round(provs.length * 0.2))
        : Math.max(1, Math.round(provs.length * 0.1));
    const border = provs.filter((id) =>
      data.provinces[id].nb.some((nb) => data.provinces[nb].c !== cid));
    const pool = border.length ? border : provs;
    // Peacetime dispositions: most of the army sits in its barracks, and the
    // rest covers the frontier. Where the archive knows no bases at all, the
    // whole force falls back to the border.
    const garrisons = basesOf.get(cid) ?? [];
    const inBarracks = Math.min(garrisons.length, Math.round(count * 0.6));
    for (let i = 0; i < count; i++) {
      const barracks = i < inBarracks ? garrisons[Math.floor(rand() * garrisons.length)] : null;
      const province = barracks ? barracks.p : pool[Math.floor(rand() * pool.length)];
      const roll = rand();
      const template: UnitKind = !isMajor
        ? (roll < 0.55 ? 'light' : roll < 0.85 ? 'territorial' : 'mechanised')
        : roll < 0.40 ? 'mechanised'
          : roll < 0.60 ? 'light'
            : roll < 0.78 ? 'armoured'
              : roll < 0.88 ? 'airborne'
                : roll < 0.95 ? 'marine' : 'territorial';
      divisions.push({
        id: nextId++,
        owner: cid,
        template,
        name: `${ORDINAL[i % ORDINAL.length]} ${TEMPLATES[template].name}`,
        province,
        pos: barracks ? [barracks.lon, barracks.lat]
          : [data.provinces[province].lon, data.provinces[province].lat],
        strength: 0.85 + rand() * 0.15,
        org: 0.9 + rand() * 0.1,
        experience: isMajor ? rand() * 0.25 : rand() * 0.08,
        path: [],
        progress: 0,
        attacking: null,
        entrenchment: 0.2,
      });
    }
  }

  const victoryPoints = new Map<number, number>();
  for (const [cid, provs] of byCountry) {
    const sorted = [...provs].sort((a, b) => data.provinces[b].a - data.provinces[a].a);
    victoryPoints.set(sorted[0], nations.get(cid)!.playable ? 25 : 10);
    for (const id of provs) if (data.provinces[id].t === 'urban') victoryPoints.set(id, 15);
  }

  // the starting wars: every nation of one bloc against every nation of another
  const wars = new Set<string>();
  for (const [x, y] of WARS) {
    const fx = factions.find((f) => f.id === x)?.members ?? [];
    const fy = factions.find((f) => f.id === y)?.members ?? [];
    for (const a of fx) for (const b of fy) wars.add(warKey(a, b));
  }

  return { nations, factions, owner, controller, divisions, victoryPoints, wars, peaceOffers: new Map() };
}

/** Are these two nations at war right now? */
/**
 * Stand up air and naval forces at real installations.
 *
 * Air wings and flotillas cannot exist in the field: each one starts at an
 * airfield or a port taken from the archive, and can only ever move between
 * them.
 */
export function garrisonBases(
  scn: Scenario,
  airfields: BaseSite[],
  ports: BaseSite[],
): { wings: number; flotillas: number } {
  let nextId = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;
  const rand = rng(77);
  let wings = 0, flotillas = 0;

  const byNation = (list: BaseSite[]) => {
    const out = new Map<number, BaseSite[]>();
    for (const i of list) {
      if (i.p < 0) continue;
      const owner = scn.controller[i.p];
      const sites = out.get(owner) ?? [];
      sites.push(i);
      out.set(owner, sites);
    }
    return out;
  };

  const air = byNation(airfields);
  const sea = byNation(ports);

  for (const [owner, nation] of scn.nations) {
    const major = nation.playable;
    const airSites = air.get(owner) ?? [];
    const seaSites = sea.get(owner) ?? [];
    const nWings = Math.min(airSites.length, major ? 6 : airSites.length > 3 ? 2 : 1);
    const nFlot = Math.min(seaSites.length, major ? 4 : seaSites.length > 2 ? 1 : 0);

    // one wing per airfield, standing on the runway itself rather than at the
    // middle of the province the runway happens to fall in
    const pick = (sites: BaseSite[], i: number) =>
      sites.length <= 1 ? sites[0] : sites[(i + Math.floor(rand() * sites.length)) % sites.length];

    const usedAir = new Set<BaseSite>();
    for (let i = 0; i < nWings; i++) {
      let site = pick(airSites, i);
      for (let t = 0; t < 8 && usedAir.has(site); t++) site = pick(airSites, i + t);
      usedAir.add(site);
      scn.divisions.push({
        id: nextId++, owner, template: 'airwing',
        name: `${i + 1} Air Wing`, province: site.p,
        pos: [site.lon, site.lat],
        strength: 0.9, org: 0.95, experience: major ? 0.2 : 0.05,
        path: [], progress: 0, attacking: null, entrenchment: 0,
      });
      wings++;
    }
    const usedSea = new Set<BaseSite>();
    for (let i = 0; i < nFlot; i++) {
      let site = pick(seaSites, i);
      for (let t = 0; t < 8 && usedSea.has(site); t++) site = pick(seaSites, i + t);
      usedSea.add(site);
      scn.divisions.push({
        id: nextId++, owner, template: 'flotilla',
        name: `${i + 1} Flotilla`, province: site.p,
        pos: [site.lon, site.lat],
        strength: 0.9, org: 0.95, experience: major ? 0.2 : 0.05,
        path: [], progress: 0, attacking: null, entrenchment: 0,
      });
      flotillas++;
    }
  }
  return { wings, flotillas };
}

export interface OobUnit {
  country: string;
  name: string;
  template: UnitKind;
  lon: number;
  lat: number;
  p: number;
  base: string | null;
}

/**
 * Give real formations their real identities.
 *
 * The generated order of battle sets the balance - how many brigades each
 * nation fields and of what type. This overwrites the identity of as many of
 * them as we have real data for, so "14th Mechanised Bde" somewhere in Bavaria
 * becomes "10th Panzer Division" at the barracks it actually occupies.
 * Everything else stays procedural.
 */
export function applyOrderOfBattle(scn: Scenario, units: OobUnit[]): number {
  const byCountry = new Map<string, OobUnit[]>();
  for (const u of units) {
    const list = byCountry.get(u.country) ?? [];
    list.push(u);
    byCountry.set(u.country, list);
  }

  let applied = 0;
  for (const [countryName, list] of byCountry) {
    const nation = [...scn.nations.values()].find((n) => n.name === countryName || n.tag === countryName);
    const id = nation?.id ?? [...scn.nations.entries()]
      .find(([, n]) => n.name === countryName)?.[0];
    if (id === undefined) continue;

    // based forces stay where they are based: a real barracks name must not
    // drag an air wing off its runway or a flotilla out of its harbour
    const mine = scn.divisions.filter((d) => d.owner === id
      && d.template !== 'airwing' && d.template !== 'flotilla' && d.template !== 'orbital');
    for (let i = 0; i < Math.min(mine.length, list.length); i++) {
      const real = list[i];
      const d = mine[i];
      d.name = real.name;
      d.template = real.template;
      if (real.p >= 0) d.province = real.p;
      d.pos = [real.lon, real.lat];
      d.route = null;
      d.target = null;
      applied++;
    }
  }
  return applied;
}

export function atWar(scn: Scenario, a: number, b: number): boolean {
  return a !== b && scn.wars.has(warKey(a, b));
}

/**
 * Declaring war is unilateral - one government decides, and the other is at
 * war whether it likes it or not. Allies of the target are dragged in.
 */
export function declareWar(scn: Scenario, aggressor: number, target: number): string {
  if (aggressor === target) return 'A nation cannot declare war on itself.';
  if (atWar(scn, aggressor, target)) return 'Already at war.';
  scn.wars.add(warKey(aggressor, target));
  scn.peaceOffers.delete(warKey(aggressor, target));
  const bloc = scn.factions.find((f) => f.members.includes(target));
  const joined: string[] = [];
  if (bloc) {
    for (const ally of bloc.members) {
      if (ally === aggressor || atWar(scn, aggressor, ally)) continue;
      scn.wars.add(warKey(aggressor, ally));
      joined.push(scn.nations.get(ally)?.name ?? '');
    }
  }
  const target_ = scn.nations.get(target)?.name ?? 'them';
  return joined.length
    ? `War declared on ${target_}. Their bloc joins: ${joined.slice(0, 4).join(', ')}${joined.length > 4 ? `, +${joined.length - 4}` : ''}.`
    : `War declared on ${target_}.`;
}

/**
 * Peace takes two. An offer stands until the other side answers it; only when
 * both have offered does the war actually end.
 */
export function proposePeace(scn: Scenario, from: number, to: number): { accepted: boolean; message: string } {
  const key = warKey(from, to);
  if (!scn.wars.has(key)) return { accepted: false, message: 'You are not at war with them.' };
  const other = scn.nations.get(to)?.name ?? 'them';
  if (scn.peaceOffers.get(key) === to) {          // they had already offered
    scn.wars.delete(key);
    scn.peaceOffers.delete(key);
    return { accepted: true, message: `Peace signed with ${other}.` };
  }
  scn.peaceOffers.set(key, from);
  return { accepted: false, message: `Peace offered to ${other}. Awaiting their answer.` };
}

/** Does this nation's government accept the standing offer? */
export function considerPeace(scn: Scenario, nation: number, other: number, losing: boolean): boolean {
  const key = warKey(nation, other);
  if (scn.peaceOffers.get(key) === undefined || scn.peaceOffers.get(key) === nation) return false;
  // a government that is losing ground is far more willing to stop
  return losing || Math.random() < 0.35;
}
