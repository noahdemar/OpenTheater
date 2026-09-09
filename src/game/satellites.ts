import { rng } from './rng';
/**
 * Satellites, and what they can see.
 *
 * A satellite is not a unit that sits on a province: it is on an orbit, and it
 * passes over. What matters at the strategic level is the ground it covers and
 * when it covers it, so each one is propagated on a circular orbit and carries
 * a footprint - the patch of the earth above whose horizon it currently
 * stands.
 *
 * The model is deliberately a two-body one with no perturbations beyond a
 * rotating earth. Over the days and weeks a campaign runs, that puts a
 * satellite in very nearly the right place at very nearly the right time,
 * which is what a strategic map needs.
 */

const EARTH_R_KM = 6371;
/** Degrees of longitude the earth turns under a satellite each minute. */
const EARTH_ROT_DEG_MIN = 360.9856 / 1440;
/** Below this, a satellite is too low on the horizon to be worth anything. */
const MIN_ELEVATION_DEG = 5;
const MU = 398600.4418;                       // km^3/s^2

export type Mission = 'recon' | 'sigint' | 'early-warning' | 'comms' | 'navigation';

export interface MissionSpec {
  id: Mission;
  label: string;
  /** what it is for, in one line */
  role: string;
  altitudeKm: number;
  inclinationDeg: number;
  color: string;
}

/**
 * Real orbital regimes: sun-synchronous imaging at a few hundred kilometres,
 * signals intelligence higher up, navigation in medium orbit, and warning and
 * communications parked on the geostationary belt.
 */
export const MISSIONS: Record<Mission, MissionSpec> = {
  recon:           { id: 'recon',         label: 'Recon',         role: 'optical imaging', altitudeKm: 500,   inclinationDeg: 97.4, color: '#7fd4ff' },
  sigint:          { id: 'sigint',        label: 'SIGINT',        role: 'signals intelligence', altitudeKm: 1100, inclinationDeg: 63.4, color: '#c79cff' },
  'early-warning': { id: 'early-warning', label: 'Early warning', role: 'missile launch detection', altitudeKm: 35786, inclinationDeg: 0, color: '#ff9f6e' },
  comms:           { id: 'comms',         label: 'Comms',         role: 'command and control relay', altitudeKm: 35786, inclinationDeg: 0, color: '#8bd8a0' },
  navigation:      { id: 'navigation',    label: 'Navigation',    role: 'positioning and timing', altitudeKm: 20200, inclinationDeg: 55, color: '#ffd479' },
};

export interface Satellite {
  id: number;
  owner: number;
  name: string;
  mission: Mission;
  altitudeKm: number;
  inclinationDeg: number;
  /** right ascension of the ascending node, degrees */
  raanDeg: number;
  /** where it is around the orbit at epoch, degrees */
  phaseDeg: number;
  periodMin: number;
  /** sub-satellite point, updated as the world runs */
  lon: number;
  lat: number;
}

/** Orbital period of a circular orbit at this altitude, in minutes. */
export function periodMinutes(altitudeKm: number): number {
  const a = EARTH_R_KM + altitudeKm;
  return (2 * Math.PI * Math.sqrt((a * a * a) / MU)) / 60;
}

/**
 * Half-angle of the footprint, in degrees of great-circle arc: how far from
 * the sub-satellite point the satellite is still above the horizon by the
 * minimum useful elevation.
 */
export function footprintDeg(altitudeKm: number): number {
  const e = (MIN_ELEVATION_DEG * Math.PI) / 180;
  const ratio = (EARTH_R_KM / (EARTH_R_KM + altitudeKm)) * Math.cos(e);
  return ((Math.acos(Math.min(1, ratio)) - e) * 180) / Math.PI;
}

/** Radius of the covered patch measured along the ground, in kilometres. */
export const footprintKm = (altitudeKm: number) =>
  (footprintDeg(altitudeKm) * Math.PI * EARTH_R_KM) / 180;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const wrapLon = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Where a satellite is over the ground at `minutes` past epoch. The orbit is
 * propagated in an inertial frame and then the earth is turned underneath it,
 * which is what gives a polar orbit its familiar westward-marching track.
 */
export function subPoint(sat: Satellite, minutes: number): [number, number] {
  const u = rad(sat.phaseDeg + (360 * minutes) / sat.periodMin);   // argument of latitude
  const i = rad(sat.inclinationDeg);
  const lat = deg(Math.asin(Math.sin(i) * Math.sin(u)));
  const lonInertial = sat.raanDeg + deg(Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u)));
  return [wrapLon(lonInertial - EARTH_ROT_DEG_MIN * minutes), lat];
}

/**
 * The footprint as a ring of points around the sub-satellite point. Longitudes
 * are left unwrapped on purpose so a footprint straddling the antimeridian
 * stays one continuous ring rather than a band smeared across the whole map.
 */
export function footprintRing(lon: number, lat: number, radiusDeg: number, steps = 72): [number, number][] {
  const ring: [number, number][] = [];
  const φ1 = rad(lat), λ1 = rad(lon), d = rad(Math.min(radiusDeg, 89.9));
  let prev: number | null = null;
  for (let k = 0; k <= steps; k++) {
    const θ = (2 * Math.PI * k) / steps;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ));
    let λ2 = deg(λ1 + Math.atan2(
      Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
      Math.cos(d) - Math.sin(φ1) * Math.sin(φ2)));
    if (prev !== null) {                       // keep the ring continuous
      while (λ2 - prev > 180) λ2 -= 360;
      while (prev - λ2 > 180) λ2 += 360;
    }
    prev = λ2;
    ring.push([λ2, deg(φ2)]);
  }
  return ring;
}

/** Is this point inside the satellite's footprint right now? */
export function covers(sat: Satellite, lon: number, lat: number): boolean {
  const φ1 = rad(sat.lat), φ2 = rad(lat), dλ = rad(lon - sat.lon);
  const c = Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return deg(Math.acos(Math.max(-1, Math.min(1, c)))) <= footprintDeg(sat.altitudeKm);
}

/** How many satellites of each mission a nation puts up, by weight class. */
const CONSTELLATION: Record<'major' | 'regional', Record<Mission, number>> = {
  major:    { recon: 6, sigint: 3, 'early-warning': 2, comms: 3, navigation: 6 },
  regional: { recon: 2, sigint: 1, 'early-warning': 0, comms: 1, navigation: 0 },
};

export class Satellites {
  readonly all: Satellite[] = [];
  /** minutes since the scenario's epoch */
  private minutes = 0;
  private nextId = 1;

  /**
   * Put a nation's constellation into orbit. Planes are spread evenly around
   * the equator and satellites evenly around each plane, which is how a real
   * constellation is built and what gives continuous coverage.
   */
  launch(owner: number, name: string, weight: 'major' | 'regional', seed = owner) {
    const rand = rng(seed * 7919 + 13);
    for (const [mission, count] of Object.entries(CONSTELLATION[weight]) as [Mission, number][]) {
      if (!count) continue;
      const spec = MISSIONS[mission];
      const geo = spec.altitudeKm > 30000;
      for (let k = 0; k < count; k++) {
        // a geostationary satellite is parked over one longitude; everything
        // else is spread around its planes
        const raan = geo
          ? wrapLon(-60 + rand() * 120 + owner * 37)
          : (360 * k) / count + rand() * 12;
        const sat: Satellite = {
          id: this.nextId++,
          owner,
          name: `${name} ${spec.label} ${k + 1}`,
          mission,
          altitudeKm: spec.altitudeKm,
          inclinationDeg: spec.inclinationDeg,
          raanDeg: raan,
          phaseDeg: geo ? 0 : (360 * k) / count + rand() * 30,
          periodMin: periodMinutes(spec.altitudeKm),
          lon: 0, lat: 0,
        };
        this.all.push(sat);
      }
    }
    this.propagate(0);
  }

  /** Advance every orbit by `hours` of game time. */
  step(hours: number) { this.propagate(hours * 60); }

  private propagate(dMinutes: number) {
    this.minutes += dMinutes;
    for (const sat of this.all) {
      const [lon, lat] = subPoint(sat, this.minutes);
      sat.lon = lon;
      sat.lat = lat;
    }
  }

  of(owner: number) { return this.all.filter((s) => s.owner === owner); }

  /** Where a satellite will be `minutes` from now, for drawing its track. */
  future(sat: Satellite, minutes: number): [number, number] {
    return subPoint(sat, this.minutes + minutes);
  }

  /** Minutes of game time since the epoch the orbits were set from. */
  get epochMinutes() { return this.minutes; }

  /** Which of a nation's satellites can see this point right now. */
  watching(lon: number, lat: number, owner?: number): Satellite[] {
    return this.all.filter((s) => (owner === undefined || s.owner === owner) && covers(s, lon, lat));
  }

  clear() { this.all.length = 0; this.nextId = 1; }
}
