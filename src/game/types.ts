/** Static world data produced by tools/genmap.mjs + tools/terrain.mjs. */
export interface ProvinceData {
  id: number;
  n: string;          // name
  c: number;          // country index
  x: number; y: number;
  lon: number; lat: number;
  a: number;          // projected area
  t: Terrain;
  o: 0 | 1;           // coastal
  nb: number[];
}

export interface CountryData { id: number; name: string; color: string }

export interface WorldData {
  width: number; height: number;
  countries: CountryData[];
  provinces: ProvinceData[];
}

export type Terrain =
  | 'plains' | 'forest' | 'taiga' | 'hills' | 'mountain' | 'desert'
  | 'jungle' | 'marsh' | 'tundra' | 'arctic' | 'urban';

/** Movement cost and combat modifiers per terrain, HOI-style. */
export const TERRAIN: Record<Terrain, { move: number; defence: number; label: string }> = {
  plains: { move: 1.0, defence: 0, label: 'Plains' },
  farmland: { move: 1.0, defence: 0, label: 'Farmland' },
  forest: { move: 1.4, defence: 0.2, label: 'Forest' },
  taiga: { move: 1.6, defence: 0.25, label: 'Taiga' },
  hills: { move: 1.5, defence: 0.3, label: 'Hills' },
  mountain: { move: 2.2, defence: 0.55, label: 'Mountains' },
  desert: { move: 1.2, defence: 0.05, label: 'Desert' },
  jungle: { move: 2.0, defence: 0.4, label: 'Jungle' },
  marsh: { move: 2.0, defence: 0.35, label: 'Marsh' },
  tundra: { move: 1.5, defence: 0.15, label: 'Tundra' },
  arctic: { move: 2.0, defence: 0.2, label: 'Arctic' },
  urban: { move: 1.3, defence: 0.45, label: 'Urban' },
} as unknown as Record<Terrain, { move: number; defence: number; label: string }>;

/**
 * Built-in unit kinds. Scenarios may define their own on top of these, so a
 * kind is a plain string at the type level and these are the ones the base
 * game ships with.
 */
export type UnitKind = string;

export type Domain = 'land' | 'air' | 'sea' | 'space';

export const BUILTIN_KINDS = [
  'mechanised', 'armoured', 'light', 'airborne', 'marine', 'territorial',
  'airwing', 'flotilla', 'orbital',
] as const;

/** Which domain a template belongs to, for icons, basing and movement. */
export const DOMAIN_OF: Record<string, Domain> = {
  mechanised: 'land', armoured: 'land', light: 'land',
  airborne: 'land', marine: 'land', territorial: 'land',
  airwing: 'air', flotilla: 'sea', orbital: 'space',
};

/**
 * Air and naval forces can only operate from an installation of their type.
 * Space assets are not based on the ground at all: they are always on station.
 */
export const BASED_AT: Record<string, 'air' | 'port' | undefined> = {
  airwing: 'air',
  flotilla: 'port',
};

export interface Template {
  kind: UnitKind;
  name: string;
  /** men in a full-strength division */
  manpower: number;
  softAttack: number;
  hardAttack: number;
  defence: number;
  breakthrough: number;
  armour: number;
  /** km/h on plains */
  speed: number;
  organisation: number;
  supplyUse: number;
  /** effective direct-fire range in metres */
  range: number;
  /** organic indirect-fire range in metres; 0 if the formation has none */
  artillery: number;
}

export interface Division {
  id: number;
  owner: number;            // nation id
  template: UnitKind;
  name: string;
  province: number;
  /** exact position on the ground; the province is derived from it */
  pos: [number, number];
  /** 0..1 of template manpower */
  strength: number;
  /** 0..1 of template organisation */
  org: number;
  experience: number;
  /** province ids still to walk through */
  path: number[];
  /** 0..1 of the way along the current route */
  progress: number;
  /** the road being marched down, as a polyline */
  route?: [number, number][] | null;
  /** length of the route, km */
  routeKm?: number;
  /** how far along it the formation has got, km */
  travelledKm?: number;
  /** the exact point it was ordered to */
  target?: [number, number] | null;
  /** province id this division is attacking, if any */
  attacking: number | null;
  /**
   * How far the column has got up to speed, 0..1.
   *
   * A division is tens of thousands of men and vehicles strung out over
   * kilometres of road. It does not leave at its march rate and it does not
   * stop dead, so orders take hours to show in the unit's actual movement.
   */
  momentum?: number;
  /** falling back after losing a province, rather than manoeuvring */
  withdrawing?: boolean;
  entrenchment: number;
  /** the army this formation has been assigned to, if any */
  army?: number;
  selected?: boolean;
}

export interface Nation {
  id: number;               // matches CountryData.id
  name: string;
  tag: string;
  color: string;
  faction: string | null;
  playable: boolean;
  /** research points per day */
  research: number;
  manpower: number;
  factories: number;
  techs: Set<string>;
  researching: { id: string; progress: number } | null;
}

export interface Faction { id: string; name: string; color: string; members: number[] }
