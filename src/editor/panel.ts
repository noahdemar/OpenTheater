import type { Domain } from '../game/types';
import { ECHELONS, type EditorModel, type Echelon, type OrbatNode } from './model';

type Tab = 'units' | 'orbat' | 'nations' | 'territory' | 'share' | 'world';

const TABS: [Tab, string][] = [
  ['units', 'Units'],
  ['orbat', 'Order of Battle'],
  ['nations', 'Nations'],
  ['territory', 'Territory'],
  ['share', 'Share'],
  ['world', 'World'],
];

const DOMAINS: Domain[] = ['land', 'air', 'sea', 'space'];

export interface EditorHooks {
  /** the province the map is currently pointing at, for placing things */
  provinceName: (id: number) => string;
  /** paint mode: which nation the next map click assigns ground to */
  onPaintNation: (tag: string | null) => void;
  /** the node awaiting a location, set by clicking the map */
  onPlaceNode: (id: string | null) => void;
  onCommit: () => void;
  /** wipe the running world to nothing */
  onClearWorld: () => void;
  /** put the shipped scenario back */
  onResetWorld: () => void;
  /** how much is currently in the world, for the World tab */
  worldSummary: () => { nations: number; divisions: number; owned: number };
  status: (text: string) => void;
}

/** The scenario editor: a document window over the running map. */
export class EditorPanel {
  readonly el: HTMLElement;
  open = false;
  private tab: Tab = 'units';
  private selectedNation: string | null = null;
  private paintTag: string | null = null;
  private placingNode: string | null = null;
  /** which destructive action is one click away from happening */
  private confirm: string | null = null;

  constructor(private model: EditorModel, private hooks: EditorHooks) {
    this.el = document.createElement('div');
    this.el.id = 'editor';
    this.el.className = 'panel';
    this.el.hidden = true;
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.el.hidden = !this.open;
    if (!this.open) {
      this.paintTag = null;
      this.placingNode = null;
      this.hooks.onPaintNation(null);
      this.hooks.onPlaceNode(null);
    }
    this.render();
  }

  /** Called when the map is clicked while a placement is pending. */
  placeAt(province: number): boolean {
    if (this.placingNode) {
      const node = this.model.orbat.find((n) => n.id === this.placingNode);
      if (node) {
        node.province = province;
        this.hooks.status(`${node.name} placed in ${this.hooks.provinceName(province)}`);
      }
      this.placingNode = null;
      this.hooks.onPlaceNode(null);
      this.render();
      return true;
    }
    if (this.paintTag) {
      this.model.assignProvince(this.paintTag, province);
      this.render();
      return true;
    }
    return false;
  }

  render() {
    if (!this.open) return;
    this.el.innerHTML = `
      <div class="head">
        <span class="dot" style="background:var(--accent)"></span>
        <div class="title">Scenario Editor</div>
        <div class="sub">${this.model.name}${this.model.author ? ` · ${this.model.author}` : ''}</div>
      </div>
      <div class="tabs">${TABS.map(([id, label]) =>
        `<button class="tab ${this.tab === id ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>
      <div class="body">${this.renderTab()}</div>`;

    this.el.querySelectorAll<HTMLElement>('.tab').forEach((b) => {
      b.onclick = () => { this.tab = b.dataset.tab as Tab; this.render(); };
    });
    this.wire();
  }

  private renderTab(): string {
    switch (this.tab) {
      case 'units': return this.unitsTab();
      case 'orbat': return this.orbatTab();
      case 'nations': return this.nationsTab();
      case 'territory': return this.territoryTab();
      case 'share': return this.shareTab();
      case 'world': return this.worldTab();
    }
  }

  // --- units ----------------------------------------------------------------

  private unitsTab(): string {
    const rows = this.model.templates.map((t) => `
      <div class="row">
        <span class="tag ${t.domain}">${t.domain}</span>
        <span class="grow">${t.name}</span>
        <span class="num">${t.softAttack}/${t.hardAttack}/${t.defence}</span>
        <button class="x" data-del-template="${t.kind}">×</button>
      </div>`).join('') || '<div class="empty">no custom units yet</div>';

    return `
      <div class="form">
        <label>Name<input id="tpl-name" placeholder="Assault Brigade"></label>
        <label>Domain<select id="tpl-domain">${DOMAINS.map((d) =>
          `<option value="${d}">${d}</option>`).join('')}</select></label>
        <div class="stats">
          <label>Soft<input id="tpl-soft" type="number" value="26"></label>
          <label>Hard<input id="tpl-hard" type="number" value="12"></label>
          <label>Defence<input id="tpl-def" type="number" value="38"></label>
          <label>Breakthr.<input id="tpl-brk" type="number" value="22"></label>
          <label>Speed<input id="tpl-speed" type="number" value="14"></label>
          <label>Range km<input id="tpl-range" type="number" value="1200"></label>
        </div>
        <button class="primary" id="tpl-add">Create unit type</button>
      </div>
      <div class="list">${rows}</div>`;
  }

  // --- order of battle ------------------------------------------------------

  private orbatTab(): string {
    if (!this.model.nations.length) {
      return '<div class="empty">create a nation first — an order of battle belongs to someone</div>';
    }
    const tag = this.selectedNation ?? this.model.nations[0].tag;
    this.selectedNation = tag;
    const templates = this.model.allTemplates();

    const branch = (parent: string | null, depth: number): string =>
      this.model.childrenOf(parent, tag).map((node) => `
        <div class="node" style="margin-left:${depth * 14}px">
          <span class="ech">${node.echelon}</span>
          <span class="grow">${node.name}</span>
          ${node.template
            ? `<span class="num">${templates.find((t) => t.kind === node.template)?.name ?? '?'}</span>`
            : ''}
          ${node.province !== null
            ? `<span class="where">${this.hooks.provinceName(node.province)}</span>`
            : ''}
          <button class="mini" data-add-child="${node.id}">+</button>
          <button class="mini" data-assign="${node.id}">unit</button>
          <button class="mini ${this.placingNode === node.id ? 'on' : ''}" data-place="${node.id}">place</button>
          <button class="x" data-del-node="${node.id}">×</button>
        </div>
        ${branch(node.id, depth + 1)}`).join('');

    return `
      <div class="form inline">
        <select id="orbat-nation">${this.model.nations.map((n) =>
          `<option value="${n.tag}" ${n.tag === tag ? 'selected' : ''}>${n.name}</option>`).join('')}</select>
        <button class="primary" id="orbat-root">Add top formation</button>
      </div>
      <div class="form inline">
        <select id="orbat-template">${templates.map((t) =>
          `<option value="${t.kind}">${t.name}${t.custom ? ' *' : ''}</option>`).join('')}</select>
        <span class="hint">pick a type, then press <b>unit</b> on a formation</span>
      </div>
      <div class="tree">${branch(null, 0) || '<div class="empty">no formations yet</div>'}</div>`;
  }

  // --- nations --------------------------------------------------------------

  private nationsTab(): string {
    const rows = this.model.nations.map((n) => `
      <div class="row">
        <span class="swatch" style="background:${n.color}"></span>
        <span class="grow">${n.name}</span>
        <span class="num">${n.provinces.length} prov</span>
        <button class="mini ${this.paintTag === n.tag ? 'on' : ''}" data-paint="${n.tag}">paint</button>
        <button class="x" data-del-nation="${n.tag}">×</button>
      </div>`).join('') || '<div class="empty">no custom nations yet</div>';

    return `
      <div class="form">
        <label>Name<input id="nat-name" placeholder="Aegean Federation"></label>
        <div class="form inline">
          <label>Colour<input id="nat-color" type="color" value="#c2734a"></label>
          <label>Bloc<select id="nat-faction">
            <option value="">unaligned</option>
            <option value="atlantic">Atlantic Pact</option>
            <option value="eurasian">Eurasian Union</option>
            <option value="eastern">Eastern Sphere</option>
            <option value="nonaligned">Southern Compact</option>
          </select></label>
        </div>
        <button class="primary" id="nat-add">Create nation</button>
      </div>
      <div class="list">${rows}</div>
      ${this.paintTag ? '<div class="note">painting — click provinces on the map to hand them over</div>' : ''}`;
  }

  // --- territory ------------------------------------------------------------

  private territoryTab(): string {
    const rows = this.model.regions.map((r) => `
      <div class="row">
        <span class="grow">${r.name}</span>
        <span class="num">${r.provinces.length} prov</span>
        <button class="x" data-del-region="${r.id}">×</button>
      </div>`).join('') || '<div class="empty">no subdivisions yet</div>';

    const nation = this.selectedNation ?? this.model.nations[0]?.tag ?? '';
    const owned = this.model.nations.find((n) => n.tag === nation)?.provinces.length ?? 0;

    return `
      <div class="note">
        A subdivision is a named group of the provinces a nation holds — its states,
        oblasts or prefectures. Paint the ground on the Nations tab first, then name it here.
      </div>
      <div class="form inline">
        <select id="reg-nation">${this.model.nations.map((n) =>
          `<option value="${n.tag}" ${n.tag === nation ? 'selected' : ''}>${n.name}</option>`).join('')}</select>
        <input id="reg-name" placeholder="Northern Marches">
        <button class="primary" id="reg-add">Name ${owned} held provinces</button>
      </div>
      <div class="list">${rows}</div>`;
  }

  // --- share ----------------------------------------------------------------

  private shareTab(): string {
    const f = this.model.toFile();
    return `
      <div class="form">
        <label>Scenario name<input id="sc-name" value="${this.model.name}"></label>
        <label>Author<input id="sc-author" value="${this.model.author}" placeholder="your name"></label>
      </div>
      <div class="form inline">
        <button class="primary" id="sc-export">Download .json</button>
        <button id="sc-copy">Copy to clipboard</button>
        <button id="sc-import">Load a file…</button>
        <input id="sc-file" type="file" accept="application/json" hidden>
      </div>
      <div class="note">
        ${f.nations.length} nations · ${f.templates.length} unit types ·
        ${f.orbat.length} formations · ${f.regions.length} subdivisions
      </div>
      <button class="primary wide" id="sc-commit">Apply scenario to the running game</button>`;
  }

  // --- world ----------------------------------------------------------------

  private worldTab(): string {
    const w = this.hooks.worldSummary();
    const confirming = (what: string) => this.confirm === what;
    return `
      <div class="note">
        The world right now: <b>${w.nations}</b> nations, <b>${w.divisions}</b> formations,
        <b>${w.owned}</b> provinces held. Clearing leaves an empty map you can build on from
        the other tabs; resetting puts the shipped 2026 scenario back.
      </div>
      <div class="form">
        <button id="w-new" class="${confirming('new') ? 'danger' : ''}">
          ${confirming('new') ? 'Discard this scenario — click again' : 'New scenario (clears the editor only)'}
        </button>
        <button id="w-clear" class="${confirming('clear') ? 'danger' : ''}">
          ${confirming('clear') ? 'Erase the whole world — click again' : 'Clear world — empty map, no nations'}
        </button>
        <button id="w-reset" class="${confirming('reset') ? 'danger' : ''}">
          ${confirming('reset') ? 'Throw away changes — click again' : 'Reset to the shipped scenario'}
        </button>
      </div>
      <div class="note">
        After clearing, build nations on the <b>Nations</b> tab, paint their ground, give them an
        <b>Order of Battle</b>, then <b>Apply</b> from the Share tab.
      </div>`;
  }

  // --- wiring ---------------------------------------------------------------

  private wire() {
    const $ = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel);
    const val = (sel: string) => $<HTMLInputElement>(sel)?.value ?? '';
    const num = (sel: string) => Number($<HTMLInputElement>(sel)?.value ?? 0);

    $('#tpl-add')?.addEventListener('click', () => {
      const name = val('#tpl-name').trim();
      if (!name) { this.hooks.status('give the unit type a name'); return; }
      this.model.addTemplate({
        name,
        domain: val('#tpl-domain') as Domain,
        softAttack: num('#tpl-soft'),
        hardAttack: num('#tpl-hard'),
        defence: num('#tpl-def'),
        breakthrough: num('#tpl-brk'),
        speed: num('#tpl-speed'),
        range: num('#tpl-range'),
      });
      this.model.applyTemplates();
      this.hooks.status(`${name} added`);
      this.render();
    });
    this.el.querySelectorAll<HTMLElement>('[data-del-template]').forEach((b) => {
      b.onclick = () => { this.model.removeTemplate(b.dataset.delTemplate!); this.render(); };
    });

    $('#orbat-nation')?.addEventListener('change', (e) => {
      this.selectedNation = (e.target as HTMLSelectElement).value;
      this.render();
    });
    $('#orbat-root')?.addEventListener('click', () => {
      const tag = this.selectedNation!;
      const n = this.model.childrenOf(null, tag).length + 1;
      this.model.addNode(tag, 'army', null, `${n} Army`);
      this.render();
    });
    this.el.querySelectorAll<HTMLElement>('[data-add-child]').forEach((b) => {
      b.onclick = () => {
        const parent = this.model.orbat.find((n) => n.id === b.dataset.addChild)!;
        const next = ECHELONS[Math.min(ECHELONS.indexOf(parent.echelon) + 1, ECHELONS.length - 1)] as Echelon;
        const count = this.model.childrenOf(parent.id, parent.nation).length + 1;
        this.model.addNode(parent.nation, next, parent.id, `${count} ${next}`);
        this.render();
      };
    });
    this.el.querySelectorAll<HTMLElement>('[data-assign]').forEach((b) => {
      b.onclick = () => {
        const node = this.model.orbat.find((n) => n.id === b.dataset.assign) as OrbatNode;
        node.template = val('#orbat-template');
        this.render();
      };
    });
    this.el.querySelectorAll<HTMLElement>('[data-place]').forEach((b) => {
      b.onclick = () => {
        this.placingNode = this.placingNode === b.dataset.place ? null : b.dataset.place!;
        this.hooks.onPlaceNode(this.placingNode);
        this.hooks.status(this.placingNode ? 'click a province to place this formation' : '');
        this.render();
      };
    });
    this.el.querySelectorAll<HTMLElement>('[data-del-node]').forEach((b) => {
      b.onclick = () => { this.model.removeNode(b.dataset.delNode!); this.render(); };
    });

    $('#nat-add')?.addEventListener('click', () => {
      const name = val('#nat-name').trim();
      if (!name) { this.hooks.status('give the nation a name'); return; }
      const n = this.model.addNation(name, val('#nat-color'), val('#nat-faction') || null);
      this.selectedNation = n.tag;
      this.hooks.status(`${name} founded`);
      this.render();
    });
    this.el.querySelectorAll<HTMLElement>('[data-paint]').forEach((b) => {
      b.onclick = () => {
        this.paintTag = this.paintTag === b.dataset.paint ? null : b.dataset.paint!;
        this.hooks.onPaintNation(this.paintTag);
        this.render();
      };
    });
    this.el.querySelectorAll<HTMLElement>('[data-del-nation]').forEach((b) => {
      b.onclick = () => { this.model.removeNation(b.dataset.delNation!); this.render(); };
    });

    $('#reg-add')?.addEventListener('click', () => {
      const tag = val('#reg-nation');
      const name = val('#reg-name').trim();
      const nation = this.model.nations.find((n) => n.tag === tag);
      if (!nation || !name) { this.hooks.status('name the subdivision first'); return; }
      this.model.addRegion(tag, name, nation.provinces);
      this.hooks.status(`${name} defined over ${nation.provinces.length} provinces`);
      this.render();
    });
    this.el.querySelectorAll<HTMLElement>('[data-del-region]').forEach((b) => {
      b.onclick = () => {
        this.model.regions = this.model.regions.filter((r) => r.id !== b.dataset.delRegion);
        this.render();
      };
    });

    $('#sc-name')?.addEventListener('input', (e) => {
      this.model.name = (e.target as HTMLInputElement).value;
    });
    $('#sc-author')?.addEventListener('input', (e) => {
      this.model.author = (e.target as HTMLInputElement).value;
    });
    $('#sc-export')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.model.toFile(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.model.name.replace(/[^\w-]+/g, '_') || 'scenario'}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.hooks.status('scenario downloaded');
    });
    $('#sc-copy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(this.model.toFile()));
        this.hooks.status('scenario copied — paste it to someone');
      } catch {
        this.hooks.status('clipboard refused; use the download instead');
      }
    });
    $('#sc-import')?.addEventListener('click', () => $<HTMLInputElement>('#sc-file')?.click());
    $('#sc-file')?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const r = this.model.load(JSON.parse(await file.text()));
        this.hooks.status(r.ok ? `loaded ${this.model.name}` : `could not load: ${r.error}`);
      } catch (err) {
        this.hooks.status(`could not read that file: ${err instanceof Error ? err.message : err}`);
      }
      this.render();
    });
    $('#sc-commit')?.addEventListener('click', () => this.hooks.onCommit());

    // Destructive actions ask once. The armed state lives on the button itself
    // rather than in a modal, so nothing blocks the map.
    const arm = (id: string, what: string, run: () => void) => {
      $(`#${id}`)?.addEventListener('click', () => {
        if (this.confirm !== what) {
          this.confirm = what;
          this.render();
          return;
        }
        this.confirm = null;
        run();
        this.render();
      });
    };
    arm('w-new', 'new', () => {
      this.model.name = 'Untitled scenario';
      this.model.author = '';
      this.model.templates = [];
      this.model.nations = [];
      this.model.orbat = [];
      this.model.regions = [];
      this.selectedNation = null;
      this.paintTag = null;
      this.hooks.onPaintNation(null);
      this.hooks.status('editor cleared');
    });
    arm('w-clear', 'clear', () => this.hooks.onClearWorld());
    arm('w-reset', 'reset', () => this.hooks.onResetWorld());
  }
}
