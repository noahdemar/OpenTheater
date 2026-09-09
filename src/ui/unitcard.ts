import { TEMPLATES } from '../game/scenario';
import type { Sim } from '../game/sim';
import { TERRAIN, type Division } from '../game/types';
import type { World } from '../game/world';
import type { Marker } from '../map/units';

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The panel that appears when units are selected. */
export class UnitCard {
  readonly el: HTMLElement;

  constructor(private world: World, private sim: Sim) {
    this.el = document.createElement('div');
    this.el.id = 'unitcard';
    this.el.className = 'panel';
    this.el.hidden = true;
  }

  clear() { this.el.hidden = true; }

  /** A battalion or company: the level you command once zoomed right in. */
  private showSubunit(marker: Marker, playerId: number) {
    const u = marker.subunit!;
    const d = marker.divisions[0];
    const tpl = TEMPLATES[u.kind];
    const province = this.world.province(d.province);
    const mine = d.owner === playerId;
    const bar = (label: string, v: number, color: string) => `
      <div class="bar"><span>${label}</span>
        <div class="track"><div style="width:${Math.max(0, Math.min(1, v)) * 100}%;background:${color}"></div></div>
        <em>${pct(v)}</em></div>`;
    this.el.innerHTML = `
      <div class="head">
        <span class="dot" style="background:${marker.color}"></span>
        <div class="title">${u.name}</div>
        <div class="sub">${u.level === 0 ? 'BATTALION' : 'COMPANY'} · ${province.n} · ${d.name}</div>
      </div>
      ${bar('org', u.org, '#d9b74a')}
      ${bar('strength', u.strength, '#6fa860')}
      <div class="grid">
        <div><span>type</span><b>${tpl.name}</b></div>
        <div><span>men</span><b>${u.men.toLocaleString()}</b></div>
        <div><span>speed</span><b>${tpl.speed} km/h</b></div>
        <div><span>armour</span><b>${tpl.armour}</b></div>
      </div>
      ${u.objective ? '<div class="orders">moving to objective</div>' : ''}
      ${mine ? '<div class="hint">click the ground to move this unit</div>'
             : '<div class="hint">foreign unit</div>'}`;
  }

  show(marker: Marker, playerId: number) {
    this.el.hidden = false;
    if (marker.subunit) { this.showSubunit(marker, playerId); return; }
    const ds = marker.divisions;
    const lead = ds[0];
    const tpl = TEMPLATES[lead.template];
    const province = this.world.province(lead.province);
    const terrain = TERRAIN[province.t];
    const mine = lead.owner === playerId;

    const bar = (label: string, v: number, color: string) => `
      <div class="bar"><span>${label}</span>
        <div class="track"><div style="width:${Math.max(0, Math.min(1, v)) * 100}%;background:${color}"></div></div>
        <em>${pct(v)}</em></div>`;

    const org = ds.reduce((s, d) => s + d.org, 0) / ds.length;
    const str = ds.reduce((s, d) => s + d.strength, 0) / ds.length;
    const battle = this.sim.battles.get(lead.province);

    this.el.innerHTML = `
      <div class="head">
        <span class="dot" style="background:${marker.color}"></span>
        <div class="title">${ds.length > 1 ? `${ds.length} divisions` : lead.name}</div>
        <div class="sub">${mine ? 'YOUR COMMAND' : 'FOREIGN UNIT'} · ${province.n} · ${terrain.label}</div>
      </div>
      ${bar('org', org, '#d9b74a')}
      ${bar('strength', str, '#6fa860')}
      ${bar('dug in', ds.reduce((s, d) => s + d.entrenchment, 0) / ds.length / 1.5, '#7d94a8')}
      <div class="grid">
        <div><span>type</span><b>${tpl.name}</b></div>
        <div><span>men</span><b>${Math.round(tpl.manpower * str * ds.length).toLocaleString()}</b></div>
        <div><span>soft atk</span><b>${tpl.softAttack}</b></div>
        <div><span>hard atk</span><b>${tpl.hardAttack}</b></div>
        <div><span>defence</span><b>${tpl.defence}</b></div>
        <div><span>breakthr.</span><b>${tpl.breakthrough}</b></div>
        <div><span>speed</span><b>${tpl.speed} km/h</b></div>
        <div><span>terrain</span><b>×${terrain.move.toFixed(1)} move</b></div>
      </div>
      ${battle ? `<div class="battle">IN COMBAT · ${battle.days.toFixed(1)} days · ${battle.progress > 0 ? 'advancing' : 'held'}</div>` : ''}
      ${lead.path.length ? `<div class="orders">moving · ${lead.path.length} provinces · ${pct(lead.progress)} to next</div>` : ''}
      ${mine ? `<div class="hint">click a province to order a move</div>` : ''}
      ${ds.length > 1 ? `<div class="roster">${ds.slice(0, 12).map((d: Division) =>
        `<div><span>${d.name}</span><em>${pct(d.org)}</em></div>`).join('')}${ds.length > 12 ? `<div class="more">+${ds.length - 12} more</div>` : ''}</div>` : ''}
    `;
  }
}
