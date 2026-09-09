import { icon } from './icon';
import type { Sim } from '../game/sim';
import type { Scenario } from '../game/scenario';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Clock, speed control and the player nation's headline numbers. */
export class TopBar {
  readonly el: HTMLElement;
  private dateEl!: HTMLElement;
  private stats!: HTMLElement;
  private speedButtons: HTMLButtonElement[] = [];

  constructor(private sim: Sim, private scn: Scenario, private playerId: () => number,
              private onPickNation: (id: number) => void,
              private onDemo?: () => void,
              private onIndustry?: () => void,
              private onSave?: () => void,
              private onLoad?: () => void,
              private canLoad?: () => boolean,
              private onEditor?: () => void,
              private onConflicts?: () => void,
              private onLayers?: () => void) {
    this.el = document.createElement('div');
    this.el.id = 'topbar';
    this.el.innerHTML = `
      <div class="brand">THEATRE</div>
      <div class="nation"><select id="nation-pick"></select></div>
      <div class="stats"></div>
      <button class="layers" title="Layers">${icon('layers')}<span>Layers</span></button>
      <button class="industry" title="Industry">${icon('factory')}<span>Industry</span></button>
      <button class="conflicts" title="Model the world's ongoing armed conflicts">${icon('flame')}<span>World Conflicts</span></button>
      <button class="editor" title="Scenario editor">${icon('editor')}<span>Scenario Editor</span></button>
      <button class="save" title="Save">${icon('save')}<span>Save</span></button>
      <button class="load" title="Load">${icon('load')}<span>Load</span></button>
      <button class="demo" title="Run the set-piece battle">${icon('play')}<span>Demo</span></button>
      <div class="clock">
        <div class="date">1 Jan 2026</div>
        <div class="speeds"></div>
      </div>`;
    this.dateEl = this.el.querySelector('.date')!;
    this.stats = this.el.querySelector('.stats')!;

    const speeds = this.el.querySelector('.speeds')!;
    for (const [i, label] of ['❚❚', '1', '2', '3', '4', '5'].entries()) {
      const b = document.createElement('button');
      if (i === 0) b.innerHTML = icon('pause', 11); else b.textContent = label;
      b.title = i === 0 ? 'Pause' : `Speed ${i}`;
      b.onclick = () => { this.sim.speed = i; this.syncSpeed(); };
      speeds.appendChild(b);
      this.speedButtons.push(b);
    }

    this.el.querySelector<HTMLButtonElement>('.demo')!.onclick = () => this.onDemo?.();
    this.el.querySelector<HTMLButtonElement>('.industry')!.onclick = () => this.onIndustry?.();
    this.el.querySelector<HTMLButtonElement>('.save')!.onclick = () => { this.onSave?.(); this.syncLoad(); };
    this.el.querySelector<HTMLButtonElement>('.editor')!.onclick = () => this.onEditor?.();
    this.el.querySelector<HTMLButtonElement>('.conflicts')!.onclick = () => this.onConflicts?.();
    this.el.querySelector<HTMLButtonElement>('.layers')!.onclick = () => this.onLayers?.();
    const load = this.el.querySelector<HTMLButtonElement>('.load')!;
    load.onclick = () => this.onLoad?.();
    this.syncLoad();

    const pick = this.el.querySelector<HTMLSelectElement>('#nation-pick')!;
    for (const n of [...scn.nations.values()].filter((n) => n.playable)) {
      const o = document.createElement('option');
      o.value = String(n.id);
      o.textContent = n.name;
      pick.appendChild(o);
    }
    pick.value = String(this.playerId());
    pick.onchange = () => this.onPickNation(Number(pick.value));
    this.syncSpeed();
  }

  /** The load button is only live when there is something to load. */
  private syncLoad() {
    const load = this.el.querySelector<HTMLButtonElement>('.load');
    if (load) load.disabled = !(this.canLoad?.() ?? false);
  }

  /** Rebuild the nation list, after the editor adds new ones. */
  refreshNations() {
    const pick = this.el.querySelector<HTMLSelectElement>('#nation-pick');
    if (!pick) return;
    const current = pick.value;
    pick.innerHTML = '';
    for (const n of [...this.scn.nations.values()].filter((x) => x.playable)) {
      const o = document.createElement('option');
      o.value = String(n.id);
      o.textContent = n.name;
      pick.appendChild(o);
    }
    pick.value = current;
  }

  private syncSpeed() {
    this.speedButtons.forEach((b, i) => b.classList.toggle('on', i === this.sim.speed));
  }

  update() {
    const d = this.sim.date;
    this.dateEl.textContent = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    this.syncLoad();
    this.syncSpeed();

    const n = this.scn.nations.get(this.playerId());
    if (!n) return;
    const divisions = this.scn.divisions.filter((x) => x.owner === n.id).length;
    const held = this.scn.controller.reduce((s, c) => s + (c === n.id ? 1 : 0), 0);
    const research = n.researching
      ? `${n.researching.id} ${Math.min(100, Math.round(n.researching.progress)).toFixed(0)}`
      : 'idle';
    this.stats.innerHTML = [
      ['divisions', divisions],
      ['provinces', held],
      ['factories', n.factories],
      ['manpower', `${(n.manpower / 1e6).toFixed(1)}M`],
      ['research', research],
    ].map(([k, v]) => `<span class="stat"><b>${v}</b>${k}</span>`).join('');
  }
}
