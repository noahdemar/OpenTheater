/**
 * The real geopolitical picture.
 *
 * Where the shipped 2026 scenario invents blocs and a world war, this models
 * the wars that are actually being fought, taken from Wikipedia's list of
 * ongoing armed conflicts (see tools/conflicts.mjs). Every conflict here is a
 * real one, with its real participants, its real start date and its real
 * death toll.
 *
 * Two things the source list does not give us, and that this file supplies:
 *
 *  - Sides. The article's Location column names the states the fighting takes
 *    place in, not who is fighting whom. Interstate wars are therefore listed
 *    explicitly below; everything else is modelled as a government against an
 *    armed movement, which is what the great majority of these conflicts are.
 *  - Ground. A civil war has to be fought over territory, so each non-state
 *    belligerent is given a contiguous block of provinces inside its host
 *    country, sized by the intensity of the conflict.
 */
import type { Scenario } from './scenario';
import { warKey } from './scenario';
import type { World } from './world';
import type { Division, Nation, UnitKind } from './types';

export type Tier = 'major' | 'minor' | 'conflict' | 'skirmish';

export interface Fatalities { low: number; high: number }

export interface ConflictRecord {
  id: string;
  name: string;
  article: string | null;
  tier: Tier;
  start: number | null;
  continent: string;
  countries: string[];
  theatres: { name: string; article: string | null; depth: number }[];
  fatalities: {
    cumulative: Fatalities | null;
    prev: Fatalities | null;
    current: Fatalities | null;
  };
}

export interface ConflictsFile {
  source: string;
  license: string;
  retrieved: string;
  tiers: { id: Tier; label: string; color: string; min: number }[];
  conflicts: ConflictRecord[];
}

/** Wikipedia's country names against the map data's. */
const ALIASES: Record<string, string> = {
  'United States': 'United States of America',
  'South Sudan': 'S. Sudan',
  'Central African Republic': 'Central African Rep.',
  'Democratic Republic of the Congo': 'Dem. Rep. Congo',
  'Republic of the Congo': 'Congo',
  'Ivory Coast': "Côte d'Ivoire",
  'Sahrawi Republic': 'W. Sahara',
  'Western Sahara': 'W. Sahara',
  'French Guiana': 'France',
  'Bosnia and Herzegovina': 'Bosnia and Herz.',
  'Dominican Republic': 'Dominican Rep.',
  'Equatorial Guinea': 'Eq. Guinea',
  'Czech Republic': 'Czechia',
  'Eswatini': 'eSwatini',
  'North Macedonia': 'Macedonia',
  'East Timor': 'Timor-Leste',
  'Republic of China': 'Taiwan',
  Burma: 'Myanmar',
};

/**
 * Conflicts fought between states, and who is on each side. Everything not
 * named here is treated as a government against an insurgency.
 *
 * Sides are given as two lists of Wikipedia country names; a nation may appear
 * in a conflict's Location column without being a belligerent (Jordan is
 * overflown, not at war), so only the states named here are put at war.
 */
const INTERSTATE: Record<string, [string[], string[]]> = {
  'russo-ukrainian-war': [['Russia'], ['Ukraine']],
  'kashmir-conflict': [['India'], ['Pakistan']],
  'nagorno-karabakh-conflict': [['Armenia'], ['Azerbaijan']],
  'arab-israeli-conflict': [['Israel'], ['Iran', 'Lebanon', 'Syria', 'Yemen', 'Palestine']],
  'western-sahara-conflict': [['Morocco'], ['W. Sahara']],
};

/**
 * Conflicts whose non-state side holds no ground worth drawing: cartel and
 * gang violence is a security emergency rather than a territorial war, so it
 * is modelled and reported without carving up the map.
 */
const NON_TERRITORIAL = new Set([
  'mexican-drug-war', 'brazilian-drug-war', 'jamaican-political-conflict',
  'honduran-gang-crackdown', 'salvadoran-gang-crackdown', 'sri-lankan-drug-war',
  'cross-border-attacks-in-sabah',
]);

/** Fraction of the host country a non-state belligerent holds, per tier. */
const HOLD: Record<Tier, number> = { major: 0.30, minor: 0.18, conflict: 0.09, skirmish: 0.035 };

/** How many brigade-equivalents each side fields, per tier. */
const FORCE: Record<Tier, number> = { major: 14, minor: 8, conflict: 4, skirmish: 2 };

/** Deaths per year, as best the source knows: this year's, else last year's. */
export function annualDeaths(c: ConflictRecord): number {
  const f = c.fatalities.current ?? c.fatalities.prev;
  return f ? f.high : 0;
}

/** 0..1 intensity, on a log scale, so a 200,000-death war is not 200x a 1,000. */
export function intensity(c: ConflictRecord): number {
  const d = annualDeaths(c);
  if (d <= 0) return 0.05;
  return Math.min(1, Math.log10(d) / 5);
}

export class Conflicts {
  readonly all: ConflictRecord[];
  readonly meta: Omit<ConflictsFile, 'conflicts'>;
  /** map-data country name -> the conflicts it is named in */
  readonly byCountry = new Map<string, ConflictRecord[]>();

  private constructor(file: ConflictsFile) {
    this.all = file.conflicts;
    const { conflicts: _drop, ...meta } = file;
    this.meta = meta;
    for (const c of this.all) {
      for (const country of c.countries) {
        const name = ALIASES[country] ?? country;
        const list = this.byCountry.get(name) ?? [];
        list.push(c);
        this.byCountry.set(name, list);
      }
    }
  }

  static async load(): Promise<Conflicts> {
    const base = import.meta.env.BASE_URL || '/';
    const file = await fetch(`${base}data/conflicts.json`, { cache: 'no-store' })
      .then((r) => r.json() as Promise<ConflictsFile>);
    return new Conflicts(file);
  }

  tier(id: Tier) { return this.meta.tiers.find((t) => t.id === id)!; }

  /** The conflicts a nation is party to, worst first. */
  of(countryName: string): ConflictRecord[] {
    return [...(this.byCountry.get(countryName) ?? [])]
      .sort((a, b) => annualDeaths(b) - annualDeaths(a));
  }

  /** Total combat deaths this year across every listed conflict. */
  get deathsThisYear() {
    return this.all.reduce((n, c) => n + annualDeaths(c), 0);
  }
}

/** Deterministic noise, so a given world always comes out the same way. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Belligerent {
  /** nation id: an existing state, or a non-state actor created here */
  id: number;
  name: string;
  state: boolean;
}

export interface ConflictState {
  record: ConflictRecord;
  /** the government side, and whoever is fighting it */
  sides: [Belligerent[], Belligerent[]];
  /** every province the fighting is over */
  provinces: number[];
  intensity: number;
}

export interface ConflictModel {
  states: ConflictState[];
  /** province id -> the worst conflict it lies inside */
  worst: Map<number, ConflictState>;
  nonStateNations: number[];
}

/**
 * Rewrite the world as it actually stands.
 *
 * Every invented war and bloc is dropped. In their place: the real conflicts,
 * their real participants, and enough force on each side to fight them. The
 * scenario object is edited in place so every reference the running game holds
 * to it stays valid.
 */
export function applyConflicts(scn: Scenario, world: World, conflicts: Conflicts): ConflictModel {
  const rand = rng(1948);
  const byName = new Map<string, number>();
  for (const [id, n] of scn.nations) byName.set(n.name, id);
  for (const c of world.countries) if (!byName.has(c.name)) byName.set(c.name, c.id);

  const nationOf = (wikiName: string): number | undefined =>
    byName.get(ALIASES[wikiName] ?? wikiName) ?? byName.get(wikiName);

  // provinces of each state, as the map data has them
  const provincesOf = new Map<number, number[]>();
  for (const p of world.provinces) {
    const list = provincesOf.get(p.c) ?? [];
    list.push(p.id);
    provincesOf.set(p.c, list);
  }

  // the shipped scenario's diplomacy is fiction; none of it survives
  scn.wars.clear();
  scn.peaceOffers.clear();
  for (const f of scn.factions) f.members.length = 0;
  for (const n of scn.nations.values()) n.faction = null;

  let nextNationId = Math.max(...scn.nations.keys(), ...world.countries.map((c) => c.id)) + 1;
  let nextDivisionId = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;

  const states: ConflictState[] = [];
  const nonStateNations: number[] = [];
  const claimed = new Set<number>();          // provinces already given to a movement

  for (const record of conflicts.all) {
    const parties = record.countries
      .map((c) => ({ wiki: c, id: nationOf(c) }))
      .filter((p): p is { wiki: string; id: number } => p.id !== undefined);
    if (!parties.length) continue;

    const dyad = INTERSTATE[record.id];
    const sides: [Belligerent[], Belligerent[]] = [[], []];
    const provinces: number[] = [];

    if (dyad) {
      // a war between states: put the named governments at war with each other
      for (const [i, names] of dyad.entries()) {
        for (const name of names) {
          const id = nationOf(name);
          if (id === undefined) continue;
          sides[i].push({ id, name: scn.nations.get(id)?.name ?? name, state: true });
        }
      }
      for (const a of sides[0]) for (const b of sides[1]) scn.wars.add(warKey(a.id, b.id));
      for (const s of [...sides[0], ...sides[1]]) provinces.push(...(provincesOf.get(s.id) ?? []));
    } else {
      // a government against an armed movement: the state or states named are
      // the government side, and the movement is raised against the first of
      // them - the country the conflict is named for
      for (const p of parties) {
        sides[0].push({ id: p.id, name: scn.nations.get(p.id)?.name ?? p.wiki, state: true });
      }
      const host = parties[0].id;
      const hostName = scn.nations.get(host)?.name ?? parties[0].wiki;
      const movement: Nation = {
        id: nextNationId++,
        name: record.name,
        tag: record.id.slice(0, 3).toUpperCase(),
        color: conflicts.tier(record.tier).color,
        faction: null,
        playable: false,
        research: 0,
        manpower: 0,
        factories: 0,
        techs: new Set(),
        researching: null,
      };
      scn.nations.set(movement.id, movement);
      nonStateNations.push(movement.id);
      sides[1].push({ id: movement.id, name: movement.name, state: false });
      for (const g of sides[0]) scn.wars.add(warKey(g.id, movement.id));

      if (!NON_TERRITORIAL.has(record.id)) {
        const held = seizeGround(world, provincesOf.get(host) ?? [], HOLD[record.tier], claimed, rand);
        for (const id of held) {
          scn.controller[id] = movement.id;
          claimed.add(id);
          provinces.push(id);
        }
        movement.manpower = held.length * 3000;
      }
      // the fighting is still over the host's ground even where no territory
      // has changed hands
      if (!provinces.length) provinces.push(...(provincesOf.get(host) ?? []));
      void hostName;
    }

    states.push({ record, sides, provinces, intensity: intensity(record) });
  }

  // forces: enough on each side to hold a front, placed on the ground it holds
  for (const st of states) {
    const n = Math.max(1, Math.round(FORCE[st.record.tier]));
    for (const side of st.sides) {
      for (const b of side) {
        const ground = b.state
          ? (provincesOf.get(b.id) ?? []).filter((p) => scn.controller[p] === b.id)
          : st.provinces.filter((p) => scn.controller[p] === b.id);
        if (!ground.length) continue;
        const already = scn.divisions.filter((d) => d.owner === b.id).length;
        const want = b.state ? Math.max(0, n - already) : n;
        for (let i = 0; i < want; i++) {
          const province = ground[Math.floor(rand() * ground.length)];
          const p = world.provinces[province];
          const template: UnitKind = b.state
            ? (rand() < 0.35 ? 'mechanised' : rand() < 0.7 ? 'light' : 'territorial')
            : (rand() < 0.75 ? 'light' : 'territorial');
          const division: Division = {
            id: nextDivisionId++,
            owner: b.id,
            template,
            name: b.state ? `${already + i + 1} Bde` : `${i + 1} Column`,
            province,
            pos: [p.lon, p.lat],
            strength: b.state ? 0.8 + rand() * 0.2 : 0.5 + rand() * 0.3,
            org: b.state ? 0.85 + rand() * 0.15 : 0.6 + rand() * 0.3,
            experience: b.state ? rand() * 0.2 : 0.1 + rand() * 0.4,
            path: [],
            progress: 0,
            attacking: null,
            entrenchment: b.state ? 0.25 : 0.4,
          };
          scn.divisions.push(division);
        }
      }
    }
  }

  // one conflict per province, so the map can colour it: the worst one wins
  const worst = new Map<number, ConflictState>();
  for (const st of states) {
    for (const p of st.provinces) {
      const prev = worst.get(p);
      if (!prev || st.intensity > prev.intensity) worst.set(p, st);
    }
  }

  return { states, worst, nonStateNations };
}

/**
 * Carve a contiguous block of provinces out of a country for an armed
 * movement, growing outward from a single seat rather than scattering cells
 * about: insurgencies hold regions, not confetti.
 */
function seizeGround(
  world: World,
  pool: number[],
  share: number,
  taken: Set<number>,
  rand: () => number,
): number[] {
  const free = pool.filter((p) => !taken.has(p));
  const want = Math.min(free.length, Math.max(1, Math.round(pool.length * share)));
  if (!free.length) return [];

  const allowed = new Set(free);
  const seed = free[Math.floor(rand() * free.length)];
  const held: number[] = [];
  const seen = new Set<number>([seed]);
  const frontier = [seed];
  while (frontier.length && held.length < want) {
    // grow from a random point on the edge, which gives a lobed border rather
    // than a disc
    const i = Math.floor(rand() * Math.min(frontier.length, 6));
    const id = frontier.splice(i, 1)[0];
    held.push(id);
    for (const nb of world.provinces[id].nb) {
      if (seen.has(nb) || !allowed.has(nb)) continue;
      seen.add(nb);
      frontier.push(nb);
    }
  }
  return held;
}
