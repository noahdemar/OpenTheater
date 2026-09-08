import type { OverlayId } from '../map/overlays';

export interface LayerToggle {
  id: string;
  label: string;
  on: boolean;
  hint?: string;
}

/** The layers panel: what is drawn on top of the world. */
export class LayersPanel {
  readonly el: HTMLElement;
  private toggles: LayerToggle[] = [
    { id: 'political', label: 'Political map', on: true, hint: 'P' },
    { id: 'frontline', label: 'Front lines', on: true },
    { id: 'units', label: 'Units', on: true, hint: 'U' },
    { id: 'plans', label: 'Plans', on: true },
    { id: 'bases', label: 'Military bases', on: true },
    { id: 'airfields', label: 'Airfields', on: true },
    { id: 'ports', label: 'Ports', on: true },
    { id: 'satellites', label: 'Satellites', on: false, hint: 'K' },
    { id: 'satfootprints', label: 'Satellite footprints', on: true },
    { id: 'conflictzones', label: 'Conflict zones', on: true },
    { id: 'nato', label: 'NATO symbols', on: false, hint: 'N' },
    { id: 'globe', label: 'Globe view', on: false, hint: 'G' },
  ];

  constructor(private onChange: (id: string, on: boolean) => void) {
    this.el = document.createElement('div');
    this.el.id = 'layers';
    this.el.className = 'panel';
    this.render();
  }

  private render() {
    this.el.innerHTML = `<div class="title">LAYERS</div>` + this.toggles.map((t) => `
      <label class="row ${t.on ? 'on' : ''}" data-id="${t.id}">
        <span class="box">${t.on ? '×' : ''}</span>
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
