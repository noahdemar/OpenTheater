import { TEMPLATES } from '../game/scenario';
import type { Scenario } from '../game/scenario';
import type { Domain, Template, UnitKind } from '../game/types';
import { DOMAIN_OF } from '../game/types';

/**
 * The scenario editor's document.
 *
 * Everything the editor produces is data: unit templates, a chain of command,
 * nations and the ground they hold. It serialises to one JSON file, which is
 * how scenarios are shared - no server, no accounts, just a file you can send
 * someone.
 */

export const SCENARIO_FORMAT = 'theatre.scenario';
export const SCENARIO_VERSION = 1;

export interface CustomTemplate extends Template {
  domain: Domain;
  /** true for templates the scenario defines rather than the base game */
  custom: true;
}

export interface CustomNation {
  tag: string;
  name: string;
  color: string;
  faction: string | null;
  /** provinces painted onto this nation */
  provinces: number[];
}

export type Echelon = 'group' | 'army' | 'corps' | 'division' | 'brigade' | 'battalion';

export const ECHELONS: Echelon[] = ['group', 'army', 'corps', 'division', 'brigade', 'battalion'];

export interface OrbatNode {
  id: string;
  name: string;
  echelon: Echelon;
  /** parent node id, or null at the top of a nation's tree */
  parent: string | null;
  /** the nation this formation belongs to */
  nation: string;
  /** only leaves carry a template and a location */
  template: UnitKind | null;
  province: number | null;
}

/** A named group of provinces: the scenario's own administrative geography. */
export interface CustomRegion {
  id: string;
  name: string;
  nation: string;
  provinces: number[];
}

export interface ScenarioFile {
  format: typeof SCENARIO_FORMAT;
  version: number;
  name: string;
  author: string;
  created: string;
  templates: CustomTemplate[];
  nations: CustomNation[];
  orbat: OrbatNode[];
  regions: CustomRegion[];
}

const uid = () => Math.random().toString(36).slice(2, 10);

export class EditorModel {
  name = 'Untitled scenario';
  author = '';
  templates: CustomTemplate[] = [];
  nations: CustomNation[] = [];
  orbat: OrbatNode[] = [];
  regions: CustomRegion[] = [];

  /** Every template the editor can place: the built-ins plus this scenario's. */
  allTemplates(): { kind: UnitKind; name: string; domain: Domain; custom: boolean }[] {
    const base = Object.values(TEMPLATES).map((t) => ({
      kind: t.kind,
      name: t.name,
      domain: DOMAIN_OF[t.kind] ?? 'land',
      custom: false,
    }));
    const mine = this.templates.map((t) => ({
      kind: t.kind, name: t.name, domain: t.domain, custom: true,
    }));
    return [...base, ...mine];
  }

  addTemplate(partial: Partial<CustomTemplate> & { name: string; domain: Domain }): CustomTemplate {
    const kind = `custom:${partial.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${uid()}`;
    const defaults: Record<Domain, Partial<Template>> = {
      land: { manpower: 4000, softAttack: 26, hardAttack: 12, defence: 38, breakthrough: 22, armour: 6, speed: 14, organisation: 58, supplyUse: 1.5, range: 1200, artillery: 14000 },
      air: { manpower: 1200, softAttack: 34, hardAttack: 26, defence: 14, breakthrough: 20, armour: 0, speed: 720, organisation: 70, supplyUse: 3, range: 400, artillery: 260000 },
      sea: { manpower: 2200, softAttack: 26, hardAttack: 30, defence: 30, breakthrough: 10, armour: 18, speed: 38, organisation: 60, supplyUse: 2.2, range: 18000, artillery: 90000 },
      space: { manpower: 300, softAttack: 18, hardAttack: 22, defence: 8, breakthrough: 12, armour: 0, speed: 27000, organisation: 80, supplyUse: 4, range: 1200, artillery: 2000000 },
    };
    const t: CustomTemplate = {
      ...(defaults[partial.domain] as Template),
      ...partial,
      kind,
      domain: partial.domain,
      custom: true,
    } as CustomTemplate;
    this.templates.push(t);
    return t;
  }

  removeTemplate(kind: UnitKind) {
    this.templates = this.templates.filter((t) => t.kind !== kind);
    for (const node of this.orbat) if (node.template === kind) node.template = null;
  }

  /** Make the scenario's templates usable by the running game. */
  applyTemplates() {
    for (const t of this.templates) TEMPLATES[t.kind] = t;
  }

  addNation(name: string, color: string, faction: string | null): CustomNation {
    const tag = name.slice(0, 3).toUpperCase() + this.nations.length;
    const nation: CustomNation = { tag, name, color, faction, provinces: [] };
    this.nations.push(nation);
    return nation;
  }

  removeNation(tag: string) {
    this.nations = this.nations.filter((n) => n.tag !== tag);
    this.orbat = this.orbat.filter((n) => n.nation !== tag);
    this.regions = this.regions.filter((r) => r.nation !== tag);
  }

  /** Paint a province into a nation, taking it off whoever held it before. */
  assignProvince(tag: string, province: number) {
    for (const n of this.nations) n.provinces = n.provinces.filter((p) => p !== province);
    this.nations.find((n) => n.tag === tag)?.provinces.push(province);
  }

  unassignProvince(province: number) {
    for (const n of this.nations) n.provinces = n.provinces.filter((p) => p !== province);
  }

  addNode(nation: string, echelon: Echelon, parent: string | null, name: string): OrbatNode {
    const node: OrbatNode = {
      id: uid(), name, echelon, parent, nation, template: null, province: null,
    };
    this.orbat.push(node);
    return node;
  }

  removeNode(id: string) {
    const doomed = new Set([id]);
    // a formation takes everything under it with it
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.orbat) {
        if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) { doomed.add(n.id); grew = true; }
      }
    }
    this.orbat = this.orbat.filter((n) => !doomed.has(n.id));
  }

  childrenOf(id: string | null, nation: string): OrbatNode[] {
    return this.orbat.filter((n) => n.nation === nation && n.parent === id);
  }

  addRegion(nation: string, name: string, provinces: number[]): CustomRegion {
    const region: CustomRegion = { id: uid(), name, nation, provinces: [...provinces] };
    this.regions.push(region);
    return region;
  }

  // --- sharing --------------------------------------------------------------

  toFile(): ScenarioFile {
    return {
      format: SCENARIO_FORMAT,
      version: SCENARIO_VERSION,
      name: this.name,
      author: this.author,
      created: new Date().toISOString(),
      templates: this.templates,
      nations: this.nations,
      orbat: this.orbat,
      regions: this.regions,
    };
  }

  load(file: unknown): { ok: boolean; error?: string } {
    const f = file as ScenarioFile;
    if (!f || f.format !== SCENARIO_FORMAT) return { ok: false, error: 'not a scenario file' };
    if (f.version > SCENARIO_VERSION) return { ok: false, error: 'made with a newer build' };
    this.name = f.name ?? 'Untitled scenario';
    this.author = f.author ?? '';
    this.templates = f.templates ?? [];
    this.nations = f.nations ?? [];
    this.orbat = f.orbat ?? [];
    this.regions = f.regions ?? [];
    this.applyTemplates();
    return { ok: true };
  }

  /**
   * Push the edited scenario into the running game: custom nations take their
   * painted ground, and the order of battle becomes real formations.
   */
  commit(scn: Scenario, nextDivisionId: () => number, at: (province: number) => [number, number]): {
    nations: number; provinces: number; units: number;
  } {
    this.applyTemplates();
    let provinces = 0;
    const idOf = new Map<string, number>();

    // Custom nations are appended to the nation table. Seed the counter
    // explicitly: on a cleared world Math.max of no keys is -Infinity, which
    // silently collapses every new nation onto one id.
    const existing = [...scn.nations.keys()];
    let nextNationId = existing.length ? Math.max(...existing) + 1 : 0;
    for (const n of this.nations) {
      const id = nextNationId++;
      idOf.set(n.tag, id);
      scn.nations.set(id, {
        id,
        name: n.name,
        tag: n.tag,
        color: n.color,
        faction: n.faction,
        playable: true,
        research: 3,
        manpower: 0,
        factories: 0,
        techs: new Set(),
        researching: null,
      });
      if (n.faction) scn.factions.find((f) => f.id === n.faction)?.members.push(id);
      for (const p of n.provinces) {
        scn.owner[p] = id;
        scn.controller[p] = id;
        provinces++;
      }
    }

    // leaves of the order of battle become formations on the map
    let units = 0;
    for (const node of this.orbat) {
      if (!node.template || node.province === null) continue;
      const owner = idOf.get(node.nation);
      if (owner === undefined) continue;
      scn.divisions.push({
        id: nextDivisionId(),
        owner,
        template: node.template,
        name: node.name,
        province: node.province,
        pos: at(node.province),
        strength: 1,
        org: 1,
        experience: 0.1,
        path: [],
        progress: 0,
        attacking: null,
        entrenchment: 0.2,
        route: null,
        target: null,
      });
      units++;
    }
    return { nations: this.nations.length, provinces, units };
  }
}
