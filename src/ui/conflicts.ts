import { annualDeaths, type ConflictRecord, type Conflicts } from '../game/conflicts';

const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

/**
 * The world conflict board: every armed conflict currently being fought,
 * ranked by how many people it is killing, with the ground it is fought over
 * one click away.
 */
export class ConflictPanel {
  readonly el: HTMLElement;
  private open = false;
  private filter: string | null = null;

  constructor(
    private conflicts: Conflicts,
    private onFocus: (c: ConflictRecord) => void,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'conflictpanel';
    this.el.className = 'panel';
    this.el.hidden = true;
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-conflict]');
      if (row) {
        const c = this.conflicts.all.find((x) => x.id === row.dataset.conflict);
        if (c) this.onFocus(c);
        return;
      }
      const tier = t.closest<HTMLElement>('[data-tier]');
      if (tier) {
        this.filter = this.filter === tier.dataset.tier ? null : tier.dataset.tier!;
        this.render();
      }
    });
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.el.hidden = !this.open;
    if (this.open) this.render();
  }

  render() {
    if (!this.open) return;
    const { conflicts } = this;
    const year = new Date().getUTCFullYear();

    const counts = new Map<string, number>();
    for (const c of conflicts.all) counts.set(c.tier, (counts.get(c.tier) ?? 0) + 1);

    const bands = conflicts.meta.tiers.map((t) => `
      <button class="band ${this.filter === t.id ? 'on' : ''}" data-tier="${t.id}">
        <span class="swatch" style="background:${t.color}"></span>
        <span class="bl">${t.label}</span>
        <span class="bn">${counts.get(t.id) ?? 0}</span>
      </button>`).join('');

    const shown = conflicts.all
      .filter((c) => !this.filter || c.tier === this.filter)
      .sort((a, b) => annualDeaths(b) - annualDeaths(a));

    const rows = shown.map((c) => {
      const tier = conflicts.tier(c.tier);
      const dead = annualDeaths(c);
      const cum = c.fatalities.cumulative;
      const running = c.start ? year - c.start : null;
      return `
        <li data-conflict="${c.id}" title="${c.countries.join(', ')}">
          <span class="dot" style="background:${tier.color}"></span>
          <span class="who">
            <span class="cn">${c.name}</span>
            <span class="cm">${c.continent}${running !== null ? ` · ${running} yrs` : ''}${c.theatres.length ? ` · ${c.theatres.length} theatres` : ''}</span>
          </span>
          <span class="num" title="combat deaths, latest year on record">${dead ? fmt(dead) : '—'}</span>
          <span class="num cumulative" title="cumulative fatalities">${cum ? fmt(cum.high) : '—'}</span>
        </li>`;
    }).join('');

    this.el.innerHTML = `
      <div class="head">
        <span class="dot" style="background:${conflicts.tier('major').color}"></span>
        <span class="title">World Conflicts</span>
        <span class="sub">${conflicts.all.length} ongoing · ${fmt(conflicts.deathsThisYear)} killed in the latest year on record</span>
      </div>
      <div class="bands">${bands}</div>
      <div class="cols"><span></span><span>Conflict</span><span>/yr</span><span>Total</span></div>
      <ol class="conflicts">${rows}</ol>
      <footer>Data: <a href="${conflicts.meta.source}" target="_blank" rel="noopener">Wikipedia, list of ongoing armed conflicts</a> · retrieved ${conflicts.meta.retrieved} · ${conflicts.meta.license}</footer>`;
  }
}
