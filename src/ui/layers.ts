import type { OverlayId } from '../map/overlays';
import { icon, type IconName } from './icon';

export interface LayerToggle {
  id: string;
  label: string;
  on: boolean;
  hint?: string;
  icon: IconName;
}

/** The layers panel: what is drawn on top of the world. */
export class LayersPanel {
  readonly el: HTMLElement;
  private toggles: LayerToggle[] = [
    { icon: 'map', id: 'political', label: 'Political map', on: true, hint: 'P' },
    { icon: 'swords', id: 'frontline', label: 'Front lines', on: true },
    { icon: 'units', id: 'units', label: 'Units', on: true, hint: 'U' },
    { icon: 'route', id: 'plans', label: 'Plans', on: true },
    { icon: 'shield', id: 'bases', label: 'Military bases', on: true },
    { icon: 'plane', id: 'airfields', label: 'Airfields', on: true },
    { icon: 'anchor', id: 'ports', label: 'Ports', on: true },
    { icon: 'satellite', id: 'satellites', label: 'Satellites', on: false, hint: 'K' },
    { icon: 'footprint', id: 'satfootprints', label: 'Satellite footprints', on: true },
    { icon: 'flame', id: 'conflictzones', label: 'Conflict zones', on: true },
    { icon: 'hash', id: 'nato', label: 'NATO symbols', on: false, hint: 'N' },
    { icon: 'globe', id: 'globe', label: 'Globe view', on: false, hint: 'G' },
  ];

  constructor(private onChange: (id: string, on: boolean) => void) {
    this.el = document.createElement('div');
    this.el.id = 'layers';
    this.el.className = 'panel';
    this.render();
  }

  private render() {
    this.el.innerHTML = `<div class="title">${icon('layers', 12)}Layers</div>` + this.toggles.map((t) => `
      <label class="row ${t.on ? 'on' : ''}" data-id="${t.id}">
        <span class="box">${t.on ? icon('close', 9) : ''}</span>
        <span class="glyph">${icon(t.icon, 13)}</span>
        <span class="name">${t.label}</span>
        ${t.hint ? `<em>${t.hint}</em>` : ''}
      </label>`).join('');
    this.el.querySelectorAll<HTMLElement>('.row').forEach((row) => {
      row.onclick = () => this.set(row.dataset.id!, !this.get(row.dataset.id!));
    });
  }

  get(id: string) { return this.toggles.find((t) => t.id === id)?.on ?? false; }

  set(id: string, on: boolean) {
    const t = this.toggles.find((x) => x.id === id);
    if (!t || t.on === on) return;
    t.on = on;
    this.render();
    this.onChange(id, on);
  }

  toggle(id: string) { this.set(id, !this.get(id)); }

  isOverlay(id: string): id is OverlayId {
    return id === 'bases' || id === 'airfields' || id === 'ports';
  }
}
