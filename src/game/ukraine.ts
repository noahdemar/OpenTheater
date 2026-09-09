/**
 * The Russo-Ukrainian war, in detail.
 *
 * Every other conflict in the model is generated from the intensity band and
 * the states the article names. That is fine for a civil war in a country the
 * player will never zoom into, and not good enough for this one: it is the
 * conflict most people looking at the map will check first, and a generic
 * insurgency wrapped around the word "Ukraine" would be obviously wrong.
 *
 * So this one is laid in by hand: the ground actually occupied, the line of
 * contact as it actually runs, and the formations actually holding the
 * sectors. The line and the order of battle are approximations - open sources
 * disagree by a few kilometres and formations rotate constantly - but they are
 * the real shape of the war rather than a procedural stand-in.
 *
 * Geography is from the public record as of early 2026; treat the sector
 * assignments as indicative rather than as current intelligence.
 */
import type { Scenario } from './scenario';
import { TEMPLATES } from './scenario';
import type { World } from './world';
import type { Zones } from './zones';
import type { Division, UnitKind } from './types';
import { rng } from './rng';

/**
 * The occupied territory, as one simple ring.
 *
 * The western edge is the line of contact - down the Oskil, through the
 * Donbas towns, west across southern Zaporizhzhia and then along the Dnipro to
 * the estuary. From there it runs out to sea, around Crimea, back up the Azov
 * coast past Mariupol, and closes well inside Russia, where every province is
 * Russian anyway.
 */
const OCCUPIED: [number, number][] = [
  // the line of contact, north to south
  [37.90, 50.30],   // the international border, north of Vovchansk
  [37.70, 50.05],
  [37.55, 49.75],   // the Oskil, east of Kupiansk
  [37.85, 49.35],   // Svatove - Lyman
  [38.05, 49.05],   // Siversk
  [38.00, 48.60],   // Chasiv Yar, west of Bakhmut
  [37.85, 48.40],   // Toretsk
  [37.50, 48.28],   // west of Avdiivka
  [37.15, 48.18],   // Pokrovsk
  [36.85, 48.02],
  [36.55, 47.88],   // Vuhledar - Velyka Novosilka
  [36.10, 47.72],
  [35.70, 47.60],   // Robotyne - Orikhiv
  [35.25, 47.52],
  [34.85, 47.60],   // the front meets the Dnipro above Enerhodar
  // down the river: the left bank is held, the right bank is not, so the line
  // runs just south of Nikopol and just south of Kherson city
  [34.45, 47.45],
  [33.95, 47.10],
  [33.55, 46.88],   // Nova Kakhovka, on the left bank
  [32.85, 46.66],
  [32.30, 46.52],   // south of Kherson city, which is Ukrainian-held
  [31.95, 46.45],   // the estuary
  // out to sea and around Crimea
  [32.20, 46.15],
  [32.40, 45.20],
  [33.30, 44.35],   // south of Sevastopol
  [34.40, 44.30],
  [35.90, 44.75],
  [36.75, 45.20],   // Kerch
  // up the Sea of Azov and along its northern shore
  [37.60, 46.00],
  [37.40, 46.85],
  [37.55, 47.05],   // Mariupol
  [38.20, 47.15],   // Novoazovsk
  // and closed off inside Russia
  [40.50, 47.60],
  [40.50, 50.30],
];

/** Sectors of the front, north to south, with a point on the line. */
const SECTORS: { name: string; at: [number, number] }[] = [
  { name: 'Kupiansk',      at: [37.60, 49.72] },
  { name: 'Lyman',         at: [37.90, 49.30] },
  { name: 'Siversk',       at: [38.05, 48.95] },
  { name: 'Chasiv Yar',    at: [37.98, 48.58] },
  { name: 'Toretsk',       at: [37.84, 48.39] },
  { name: 'Pokrovsk',      at: [37.18, 48.20] },
  { name: 'Velyka Novosilka', at: [36.58, 47.90] },
  { name: 'Orikhiv',       at: [35.72, 47.60] },
  { name: 'Zaporizhzhia',  at: [35.20, 47.51] },
  { name: 'Dnipro line',   at: [33.20, 46.78] },
];

type Formation = { name: string; kind: UnitKind; sector: number };

/**
 * Formations, by the sector each is publicly associated with.
 *
 * Both armies rotate units constantly, so this is a plausible order of battle
 * rather than a current one - the point is that the counters on the map carry
 * the names of real formations in roughly the right places.
 */
const UKRAINIAN: Formation[] = [
  { name: '92nd Assault Bde',            kind: 'mechanised',  sector: 0 },
  { name: '14th Mechanised Bde',         kind: 'mechanised',  sector: 0 },
  { name: '3rd Assault Bde',             kind: 'mechanised',  sector: 1 },
  { name: '63rd Mechanised Bde',         kind: 'mechanised',  sector: 1 },
  { name: '81st Airmobile Bde',          kind: 'airborne',    sector: 2 },
  { name: '10th Mountain Assault Bde',   kind: 'light',       sector: 2 },
  { name: '93rd Mechanised Bde',         kind: 'mechanised',  sector: 3 },
  { name: '24th Mechanised Bde',         kind: 'mechanised',  sector: 4 },
  { name: '32nd Mechanised Bde',         kind: 'mechanised',  sector: 4 },
  { name: '47th Mechanised Bde',         kind: 'armoured',    sector: 5 },
  { name: '25th Airborne Bde',           kind: 'airborne',    sector: 5 },
  { name: '68th Jaeger Bde',             kind: 'light',       sector: 5 },
  { name: '79th Air Assault Bde',        kind: 'airborne',    sector: 6 },
  { name: '72nd Mechanised Bde',         kind: 'mechanised',  sector: 6 },
  { name: '128th Mountain Assault Bde',  kind: 'light',       sector: 7 },
  { name: '65th Mechanised Bde',         kind: 'mechanised',  sector: 7 },
  { name: '82nd Air Assault Bde',        kind: 'airborne',    sector: 8 },
  { name: '118th Mechanised Bde',        kind: 'mechanised',  sector: 8 },
  { name: '35th Marine Bde',             kind: 'marine',      sector: 9 },
  { name: '36th Marine Bde',             kind: 'marine',      sector: 9 },
];

const RUSSIAN: Formation[] = [
  { name: '1st Gds Tank Army',           kind: 'armoured',    sector: 0 },
  { name: '6th Combined Arms Army',      kind: 'mechanised',  sector: 0 },
  { name: '20th Combined Arms Army',     kind: 'mechanised',  sector: 1 },
  { name: '3rd Combined Arms Army',      kind: 'mechanised',  sector: 2 },
  { name: '2nd Gds Combined Arms Army',  kind: 'mechanised',  sector: 3 },
  { name: '8th Gds Combined Arms Army',  kind: 'mechanised',  sector: 4 },
  { name: '51st Combined Arms Army',     kind: 'mechanised',  sector: 5 },
  { name: '41st Combined Arms Army',     kind: 'armoured',    sector: 5 },
  { name: '90th Gds Tank Div',           kind: 'armoured',    sector: 5 },
  { name: '5th Combined Arms Army',      kind: 'mechanised',  sector: 6 },
  { name: '36th Combined Arms Army',     kind: 'mechanised',  sector: 6 },
  { name: '58th Combined Arms Army',     kind: 'mechanised',  sector: 7 },
  { name: '76th Gds Air Assault Div',    kind: 'airborne',    sector: 7 },
  { name: '35th Combined Arms Army',     kind: 'mechanised',  sector: 8 },
  { name: '7th Gds Air Assault Div',     kind: 'airborne',    sector: 8 },
  { name: '18th Combined Arms Army',     kind: 'mechanised',  sector: 9 },
  { name: '810th Naval Infantry Bde',    kind: 'marine',      sector: 9 },
  { name: '49th Combined Arms Army',     kind: 'mechanised',  sector: 9 },
];

/** Rear formations, spread behind each side's line. */
const UKRAINIAN_DEPTH = 26;
const RUSSIAN_DEPTH = 34;

function inRing(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > py) !== (b[1] > py) && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is this point on the Russian-held side of the line? */
export const occupied = (lon: number, lat: number) => inRing(lon, lat, OCCUPIED);

export interface UkraineResult {
  provincesOccupied: number;
  zonesOccupied: number;
  ukrainian: number;
  russian: number;
}

/**
 * Lay the war onto the map.
 *
 * Territory first: any province wholly inside the occupied ring changes hands
 * outright, and any province the line runs through is split zone by zone, so
 * the front follows the real line of contact rather than jumping to whichever
 * province edge happens to be nearest. That is exactly the case sub-province
 * zones were built for.
 */
export function applyUkraine(
  scn: Scenario, world: World, zones: Zones | null,
  ukraine: number, russia: number,
): UkraineResult {
  const rand = rng(2022);
  let provincesOccupied = 0, zonesOccupied = 0;

  // Cut the ground the line runs through more finely than area alone would.
  // The default cut is about twenty kilometres across, which cannot tell
  // Kherson on the right bank from Nova Kakhovka on the left.
  if (zones) {
    const onLine = new Set<number>();
    for (let i = 1; i < OCCUPIED.length; i++) {
      const [ax, ay] = OCCUPIED[i - 1], [bx, by] = OCCUPIED[i];
      const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const p = world.provinceAt(ax + (bx - ax) * t, ay + (by - ay) * t);
        if (p >= 0) onLine.add(p);
      }
    }
    for (const p of onLine) {
      if (scn.controller[p] !== ukraine && scn.controller[p] !== russia) continue;
      zones.refine(p, 72);
      for (const nb of world.province(p).nb) {
        if (scn.controller[nb] === ukraine || scn.controller[nb] === russia) zones.refine(nb, 48);
      }
    }
  }

  for (const p of world.provinces) {
    if (scn.controller[p.id] !== ukraine) continue;
    if (!zones) {
      if (occupied(p.lon, p.lat)) { scn.controller[p.id] = russia; provincesOccupied++; }
      continue;
    }
    const cells = zones.of(p.id);
    if (!cells.length) {
      if (occupied(p.lon, p.lat)) { scn.controller[p.id] = russia; provincesOccupied++; }
      continue;
    }
    const taken = cells.filter((z) => occupied(z.lon, z.lat));
    if (!taken.length) continue;
    if (taken.length === cells.length) {
      // wholly behind the line: the province itself changes hands
      scn.controller[p.id] = russia;
      provincesOccupied++;
    } else {
      // the line runs through this cell, so it is held zone by zone
      for (const z of taken) { zones.controller.set(z.id, russia); zonesOccupied++; }
    }
  }

  // and the armies holding it
  let nextId = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;
  const place = (
    owner: number, list: Formation[], depth: number, side: -1 | 1, label: string,
  ): number => {
    const made: Division[] = [];
    const put = (name: string, kind: UnitKind, at: [number, number], quality: number) => {
      const province = world.provinceAt(at[0], at[1]);
      if (province < 0) return;
      made.push({
        id: nextId++,
        owner,
        template: kind,
        name,
        province,
        pos: at,
        strength: 0.68 + quality * 0.24 + rand() * 0.08,
        org: 0.6 + quality * 0.3 + rand() * 0.1,
        // four years in: these are experienced armies, whatever else they are
        experience: 0.45 + rand() * 0.35,
        path: [],
        progress: 0,
        attacking: null,
        entrenchment: 0.6 + rand() * 0.3,
      });
    };

    // named formations, on the sector each is associated with
    for (const f of list) {
      const s = SECTORS[f.sector];
      // stood off from the line on their own side, spread along the sector
      const at: [number, number] = [
        s.at[0] + side * 0.16 + (rand() - 0.5) * 0.14,
        s.at[1] + (rand() - 0.5) * 0.22,
      ];
      put(f.name, f.kind, at, 0.9);
    }

    // and the rest of the force, in depth behind the line
    for (let i = 0; i < depth; i++) {
      const s = SECTORS[Math.floor(rand() * SECTORS.length)];
      const back = 0.35 + rand() * 1.5;
      const at: [number, number] = [
        s.at[0] + side * back,
        s.at[1] + (rand() - 0.5) * 0.8,
      ];
      const roll = rand();
      const kind: UnitKind = roll < 0.4 ? 'mechanised' : roll < 0.62 ? 'light'
        : roll < 0.78 ? 'armoured' : roll < 0.9 ? 'territorial' : 'airborne';
      put(`${i + 1} ${label} ${TEMPLATES[kind].name}`, kind, at, 0.55);
    }

    for (const d of made) scn.divisions.push(d);
    return made.length;
  };

  // the Russians stand east of the line, the Ukrainians west of it
  const russian = place(russia, RUSSIAN, RUSSIAN_DEPTH, 1, 'Res.');
  const ukrainian = place(ukraine, UKRAINIAN, UKRAINIAN_DEPTH, -1, 'TDF');

  return { provincesOccupied, zonesOccupied, ukrainian, russian };
}
