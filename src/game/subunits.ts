import { TEMPLATES } from './scenario';
import type { Division, UnitKind } from './types';

/**
 * Sub-units are derived, not stored.
 *
 * A brigade counter is the strategic object; its battalions and companies are
 * generated deterministically from the brigade's id, so every peer produces the
 * same formation without sending any of it over the wire. Only a sub-unit the
 * player actually gives an order to gets persistent state.
 */

export interface Subunit {
  id: string;
  division: number;
  kind: UnitKind;
  name: string;
  /** 0 = battalion, 1 = company */
  level: 0 | 1;
  lon: number; lat: number;
  objective: [number, number] | null;
  strength: number;
  org: number;
  men: number;
}

const BATTALIONS: Record<string, number> = {
  mechanised: 4, armoured: 3, light: 4, airborne: 3, marine: 3, territorial: 2,
  // an air wing resolves into squadrons, a flotilla into its ships
  airwing: 3, flotilla: 4, orbital: 2,
};
const DEFAULT_BATTALIONS = 3;
const COMPANIES = 4;

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Stable pseudo-random in [0,1) from two integers. */
function hash(a: number, b: number): number {
  let t = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35);
  t ^= t >>> 15;
  return (t >>> 0) / 4294967296;
}

/** Metres -> degrees at a given latitude. */
export const mToDeg = (m: number, lat: number): [number, number] =>
  [m / (111320 * Math.cos((lat * Math.PI) / 180)), m / 110540];

/** Degrees -> metres, for measuring the gap between two units. */
export function metresBetween(a: [number, number], b: [number, number]): number {
  const lat = (a[1] + b[1]) / 2;
  const dx = (a[0] - b[0]) * 111320 * Math.cos((lat * Math.PI) / 180);
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

/**
 * Where a formation is fighting: the contact point between it and its
 * opponent, and the axis of the front there.
 */
export interface Contact {
  /** point on the line of contact */
  lon: number; lat: number;
  /** unit vector pointing from this formation toward the enemy */
  ax: number; ay: number;
}

/**
 * Battalions of a brigade that is in contact, arrayed along the front rather
 * than scattered around the province centre: spread perpendicular to the axis
 * of advance and set back from the line of contact by `standoff` metres.
 */
export function battalionsInContact(d: Division, contact: Contact, standoff: number, frontage: number): Subunit[] {
  const n = BATTALIONS[d.template] ?? DEFAULT_BATTALIONS;
  const tpl = TEMPLATES[d.template];
  const [dxLon, dxLat] = mToDeg(1, contact.lat);
  // perpendicular to the axis, in metres
  const px = -contact.ay, py = contact.ax;
  const out: Subunit[] = [];
  for (let i = 0; i < n; i++) {
    const along = ((i + 0.5) / n - 0.5) * frontage;
    const jitter = (hash(d.id, i + 5) - 0.5) * frontage * 0.12;
    const back = standoff * (0.8 + hash(d.id, i + 33) * 0.45);
    const mx = px * (along + jitter) - contact.ax * back;
    const my = py * (along + jitter) - contact.ay * back;
    out.push({
      id: `${d.id}:${i}`,
      division: d.id,
      kind: d.template,
      name: `${i + 1} Bn / ${d.name}`,
      level: 0,
      lon: contact.lon + mx * dxLon,
      lat: contact.lat + my * dxLat,
      objective: null,
      strength: Math.max(0.05, d.strength * (0.85 + hash(d.id, i + 91) * 0.3)),
      org: Math.max(0, Math.min(1, d.org * (0.85 + hash(d.id, i + 17) * 0.3))),
      men: Math.round((tpl.manpower / n) * d.strength),
    });
  }
  return out;
}

/**
 * The battalions of a brigade, laid out in a wedge around its position.
 * `spreadM` is the formation's frontage in metres.
 */
export function battalionsOf(d: Division, lon: number, lat: number, spreadM: number): Subunit[] {
  const n = BATTALIONS[d.template] ?? DEFAULT_BATTALIONS;
  const tpl = TEMPLATES[d.template];
  const out: Subunit[] = [];
  for (let i = 0; i < n; i++) {
    const angle = i * GOLDEN + hash(d.id, i) * 0.6;
    const radius = spreadM * (0.45 + 0.55 * ((i + 1) / n));
    const [dx, dy] = mToDeg(radius, lat);
    out.push({
      id: `${d.id}:${i}`,
      division: d.id,
      kind: d.template,
      name: `${i + 1} Bn / ${d.name}`,
      level: 0,
      lon: lon + Math.cos(angle) * dx,
      lat: lat + Math.sin(angle) * dy * 0.6,
      objective: null,
      strength: Math.max(0.05, d.strength * (0.85 + hash(d.id, i + 91) * 0.3)),
      org: Math.max(0, Math.min(1, d.org * (0.85 + hash(d.id, i + 17) * 0.3))),
      men: Math.round((tpl.manpower / n) * d.strength),
    });
  }
  return out;
}

/** The companies of a battalion, in a looser scatter. */
export function companiesOf(bn: Subunit, spreadM: number): Subunit[] {
  const out: Subunit[] = [];
  for (let i = 0; i < COMPANIES; i++) {
    const angle = i * GOLDEN * 2 + hash(bn.division * 31 + i, 7) * 1.2;
    const radius = spreadM * (0.35 + 0.65 * hash(bn.division + i, 53));
    const [dx, dy] = mToDeg(radius, bn.lat);
    out.push({
      id: `${bn.id}.${i}`,
      division: bn.division,
      kind: bn.kind,
      name: `${String.fromCharCode(65 + i)} Coy / ${bn.name.split(' / ')[0]}`,
      level: 1,
      lon: bn.lon + Math.cos(angle) * dx,
      lat: bn.lat + Math.sin(angle) * dy * 0.6,
      objective: null,
      strength: Math.max(0.05, bn.strength * (0.9 + hash(bn.division + i, 11) * 0.2)),
      org: bn.org,
      men: Math.round(bn.men / COMPANIES),
    });
  }
  return out;
}

/** Speed of a sub-unit on the ground, metres per hour. */
export function subunitSpeed(kind: UnitKind): number {
  return TEMPLATES[kind].speed * 1000;
}
