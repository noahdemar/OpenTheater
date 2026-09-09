import { atWar, declareWar, proposePeace, warKey, type Scenario } from '../game/scenario';

/** The diplomacy panel: who they are, and what you can do about it. */
export class NationPanel {
  readonly el: HTMLElement;
  private current: number | null = null;

  constructor(
    private scn: Scenario,
    private playerId: () => number,
    private onChange: (message: string) => void,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'nationpanel';
    this.el.className = 'panel';
    this.el.hidden = true;
  }

  clear() { this.el.hidden = true; this.current = null; }

  show(nationId: number) {
    const { scn } = this;
    const nation = scn.nations.get(nationId);
    if (!nation) return;
    this.current = nationId;
    this.el.hidden = false;

    const me = this.playerId();
    const war = atWar(scn, me, nationId);
    const key = warKey(me, nationId);
    const offer = scn.peaceOffers.get(key);
    const bloc = scn.factions.find((f) => f.members.includes(nationId));
    const provinces = scn.controller.reduce((s, c) => s + (c === nationId ? 1 : 0), 0);
    const divisions = scn.divisions.filter((d) => d.owner === nationId).length;
    const isSelf = nationId === me;

    const actions = isSelf
      ? '<div class="hint">your own nation</div>'
      : war
        ? `<button data-act="peace">${offer === me ? 'Peace offered — awaiting reply' : offer === nationId ? 'Accept peace' : 'Sue for peace'}</button>`
        : '<button data-act="war" class="danger">Declare war</button>';

    this.el.innerHTML = `
      <div class="head">
        <span class="dot" style="background:${nation.color}"></span>
        <div class="title">${nation.name}</div>
        <div class="sub">${bloc ? bloc.name : 'Unaligned'}${war ? ' · AT WAR WITH YOU' : ''}</div>
      </div>
      <div class="kv"><span>provinces</span><span>${provinces}</span></div>
      <div class="kv"><span>brigades</span><span>${divisions}</span></div>
      <div class="kv"><span>factories</span><span>${nation.factories}</span></div>
      <div class="kv"><span>manpower</span><span>${(nation.manpower / 1e6).toFixed(1)}M</span></div>
      <div class="acts">${actions}</div>`;

    this.el.querySelector<HTMLButtonElement>('[data-act="war"]')?.addEventListener('click', () => {
      this.onChange(declareWar(scn, me, nationId));
      this.show(nationId);
    });
    this.el.querySelector<HTMLButtonElement>('[data-act="peace"]')?.addEventListener('click', () => {
      const r = proposePeace(scn, me, nationId);
      this.onChange(r.message);
      this.show(nationId);
    });
  }

  refresh() { if (this.current !== null && !this.el.hidden) this.show(this.current); }
}
