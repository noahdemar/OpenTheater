import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Battle, Sim } from '../game/sim';
import type { Scenario } from '../game/scenario';
import type { Division } from '../game/types';
import type { World } from '../game/world';
import { buildHierarchy, nodesAtLevel, refreshPositions, type Node } from '../game/hierarchy';
import {
  battalionsInContact, battalionsOf, companiesOf, metresBetween, mToDeg,
  type Contact, type Subunit,
} from '../game/subunits';
import { TEMPLATES } from '../game/scenario';
import { Effects } from './effects';
import { PLAN_STYLE, type Plan, type PlanStore } from '../game/plans';
import { combatRadius, type AirOperations } from '../game/air';
import { BASED_AT } from '../game/types';
import { COUNTER_H, COUNTER_W, counterCanvas, type Echelon, type IconStyle } from './counters';
import { LEVELS as LADDER } from './scale';

/** One clickable thing on the map, at whatever echelon is currently in view. */
export interface Marker {
  key: string;
  lon: number; lat: number;
  x: number; y: number;
  level: number;
  alpha: number;
  scale: number;
  divisions: Division[];
  echelon: Echelon;
  owner: number;
  color: string;
  label: string;
  node?: Node;
  subunit?: Subunit;
  /** where this marker's parent sits, for the connecting line */
  parent?: [number, number];
}

/**
 * The command ladder, and the zoom at which each level is fully resolved.
 * Between two anchors the upper level fades out while the lower fades in and
 * slides out from under it, so a formation visibly decomposes into its parts
 * instead of popping.
 */
const COUNTER_ECHELON: Echelon[] = ['group', 'army', 'corps', 'brigade', 'battalion', 'company'];
const LEVELS = LADDER.map((l) => ({ ...l, echelon: COUNTER_ECHELON[l.level] }));

const smoothstep = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Formation frontage on the ground, in metres - fixed, not screen-relative. */
const BATTALION_SPREAD_M = 5000;
const COMPANY_SPREAD_M = 1400;
/** How far each side sits back from the line of contact when fighting. */
const STANDOFF_M = 420;
const CONTACT_FRONTAGE_M = 2600;
/** Below this zoom, gunfire is not worth simulating - you cannot see it. */
const EFFECTS_ZOOM = 10.5;

interface Engagement {
  from: [number, number];
  to: [number, number];
  /** shots per second this pair produces */
  rate: number;
  hot: boolean;
  artillery: boolean;
}

export class UnitOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private roots: Node[] = [];
  markers: Marker[] = [];
  selected = new Set<number>();
  selectedUnits = new Set<string>();
  hovered: string | null = null;
  visible = true;
  /** whose arrows to draw */
  playerId = -1;
  /** NATO symbols, or silhouettes of the actual equipment */
  iconStyle: IconStyle = 'pictorial';
  /** true while the map is a globe, so the far hemisphere can be hidden */
  globe = false;
  readonly effects = new Effects();
  /** set once installations have loaded */
  air: AirOperations | null = null;
  /** the selection rectangle being dragged, in screen pixels */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** provinces that just changed hands, briefly highlighted */
  private flashes: { lon: number; lat: number; color: string; t: number }[] = [];
  engagements: Engagement[] = [];
  showPlans = true;
  plans: PlanStore | null = null;
  /** live cursor position while a plan is being drawn */
  draftCursor: [number, number] | null = null;

  constructor(
    private map: MapLibreMap,
    private world: World,
    private scn: Scenario,
    private sim: Sim,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'unit-overlay';
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    map.on('resize', () => this.resize());
    this.roots = buildHierarchy(scn, (d) => this.drawnAt(d));
  }

  /** Rebuild the command tree, after the order of battle changes. */
  rebuildHierarchy() {
    this.roots = buildHierarchy(this.scn, (d) => this.drawnAt(d));
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Eased display positions.
   *
   * The simulation is free to move a formation discontinuously - a brigade in
   * contact is shown deployed on the border rather than at its own map
   * position, and that deployment appears and disappears the instant a battle
   * starts or ends. Drawn literally, counters flick between the two.
   *
   * These hold where each formation is currently *drawn* and walk it towards
   * where it should be, in geographic space so a counter never drifts under
   * the cursor as the camera moves. A move longer than SNAP_DEG is a genuine
   * relocation, not a deployment, and is taken instantly - sliding a counter
   * across a continent would be worse than the jump.
   */
  private shown = new Map<number, [number, number]>();

  /** Where a division is. Position is authoritative; the province follows it. */
  position(d: Division): [number, number] {
    // a wing sits at its field unless it is out on a sortie
    if (this.air && BASED_AT[d.template] === 'air') return this.air.position(d);
    return d.pos;
  }

  /**
   * Advance every drawn position towards its true one. Called once per frame
   * from tick(), so easing runs on wall clock and stays smooth whatever speed
   * the game clock is running at.
   */
  private easePositions(dt: number) {
    const SNAP_DEG = 3;
    // ~0.45s to close the gap, which reads as a deliberate move rather than a
    // slide, and is short enough not to lag a fast-forwarded battle
    const k = 1 - Math.exp(-dt / 0.45);
    const contacts = this.contacts();
    const live = new Set<number>();

    for (const d of this.scn.divisions) {
      live.add(d.id);
      const c = contacts.get(d.id);
      const truth = this.position(d);
      const target: [number, number] = c ? [c.lon, c.lat] : truth;
      const cur = this.shown.get(d.id);
      if (!cur) { this.shown.set(d.id, [target[0], target[1]]); continue; }
      const dx = target[0] - cur[0], dy = target[1] - cur[1];
      if (Math.abs(dx) > SNAP_DEG || Math.abs(dy) > SNAP_DEG) {
        cur[0] = target[0]; cur[1] = target[1];
        continue;
      }
      cur[0] += dx * k;
      cur[1] += dy * k;
    }
    // formations that no longer exist should not keep a slot forever
    if (this.shown.size > live.size) {
      for (const id of this.shown.keys()) if (!live.has(id)) this.shown.delete(id);
    }
  }

  /** The eased position of a formation, for drawing and for hit testing. */
  drawnAt(d: Division): [number, number] {
    return this.shown.get(d.id) ?? this.position(d);
  }

  /** Which two levels are on screen, and how far between them we are. */
  private blend(zoom: number) {
    if (zoom <= LEVELS[0].zoom) return { a: LEVELS[0], b: LEVELS[0], t: 0 };
    const last = LEVELS[LEVELS.length - 1];
    if (zoom >= last.zoom) return { a: last, b: last, t: 0 };
    let i = 0;
    while (i < LEVELS.length - 1 && zoom >= LEVELS[i + 1].zoom) i++;
    const a = LEVELS[i], b = LEVELS[i + 1];
    return { a, b, t: smoothstep((zoom - a.zoom) / (b.zoom - a.zoom)) };
  }

  rebuild() {
    const zoom = this.map.getZoom();
    const { a, b, t } = this.blend(zoom);
    for (const r of this.roots) refreshPositions(r, (d) => this.drawnAt(d));

    const markers: Marker[] = [];
    if (a.level === b.level) {
      markers.push(...this.markersFor(a, 1, false));
    } else {
      // both echelons are on the map at once; the upper one fades out while the
      // lower fades in, linked by lines so the decomposition is legible
      markers.push(...this.markersFor(a, 1 - t, false));
      markers.push(...this.markersFor(b, t, true));
    }
    this.markers = markers;
    this.buildEngagements();
  }

  /**
   * Markers for one level, at a given opacity.
   *
   * Every counter is drawn at the geographic position of what it represents.
   * Zooming changes which echelon is visible and how strongly, never where a
   * counter sits - a unit is on the ground, so it must not drift under the
   * cursor as the view changes.
   */
  private markersFor(spec: typeof LEVELS[number], alpha: number, linked: boolean): Marker[] {
    if (alpha <= 0.01) return [];
    const out: Marker[] = [];
    const scale = spec.scale * lerp(0.82, 1, alpha);

    if (spec.level <= 3) {
      const parentLevel = Math.max(0, spec.level - 1);
      const parents = spec.level > 0 ? nodesAtLevel(this.roots, parentLevel) : [];
      const parentOf = new Map<string, Node>();
      for (const p of parents) for (const c of p.children) parentOf.set(c.id, p);

      for (const n of nodesAtLevel(this.roots, spec.level)) {
        const p = parentOf.get(n.id);
        out.push({
          key: n.id, lon: n.lon, lat: n.lat, x: 0, y: 0,
          level: spec.level, alpha, scale,
          divisions: n.divisions, echelon: spec.echelon,
          owner: n.owner, color: n.color, label: n.label, node: n,
          parent: p && linked ? [p.lon, p.lat] : undefined,
        });
      }
      return out;
    }

    // below brigade the formation is derived from the brigade itself
    const bounds = this.map.getBounds();
    const pad = 0.4;
    const [w, s, e, n2] = [bounds.getWest() - pad, bounds.getSouth() - pad,
      bounds.getEast() + pad, bounds.getNorth() + pad];
    const spread = spec.level === 5 ? COMPANY_SPREAD_M : BATTALION_SPREAD_M;
    const contacts = this.contacts();

    for (const d of this.scn.divisions) {
      const contact = contacts.get(d.id);
      // A formation in contact has deployed forward onto the border, which can
      // be a long way from its province centre. The eased position already
      // holds wherever it has got to between the two, so the battalions are
      // laid out around that rather than snapping between the two places.
      const [lon, lat] = this.drawnAt(d);
      const at: [number, number] = [lon, lat];
      if (at[0] < w || at[0] > e || at[1] < s || at[1] > n2) continue;
      const nation = this.scn.nations.get(d.owner)!;
      // the contact keeps its facing, but the line forms up around wherever
      // the formation has actually got to
      const bns = contact
        ? battalionsInContact(d, { ...contact, lon, lat }, STANDOFF_M, CONTACT_FRONTAGE_M)
        : battalionsOf(d, lon, lat, BATTALION_SPREAD_M);
      for (const bn of bns) {
        const units = spec.level === 5 ? companiesOf(bn, spread) : [bn];
        for (const u of units) {
          const stored = this.sim.subunits.get(u.id);
          if (stored) { u.lon = stored.lon; u.lat = stored.lat; u.objective = stored.objective; }
          const anchor: [number, number] = spec.level === 5 ? [bn.lon, bn.lat] : [lon, lat];
          out.push({
            key: u.id, lon: u.lon, lat: u.lat, x: 0, y: 0,
            level: spec.level, alpha, scale,
            divisions: [d], echelon: spec.echelon,
            owner: d.owner, color: nation.color, label: u.name, subunit: u,
            parent: linked ? anchor : undefined,
          });
        }
      }
      if (out.length > 1200) break;
    }
    return out;
  }

  /**
   * Where each engaged brigade meets its enemy. The contact point is taken
   * from the shared border segments between the two provinces, so a firing
   * line sits on the actual frontier rather than halfway between two centroids.
   */
  /** contacts change only when the sim does, so they are worked out once a frame */
  private contactCache: Map<number, Contact> | null = null;

  /**
   * Where a set piece says the firing line is.
   *
   * Contacts are normally derived from the border two provinces share, which
   * is right for a continental front and wrong for a landing: province cells
   * here are a hundred kilometres across, so a battle for an island resolves
   * on a border out at sea. A staged assault supplies its own line and
   * everything that reads contacts - counters, battalions, tracer, shellfire -
   * follows it.
   */
  contactOverride: Map<number, Contact> | null = null;

  private contacts(): Map<number, Contact> {
    if (this.contactCache) return this.contactCache;
    const out = new Map<number, Contact>();
    for (const battle of this.sim.battles.values()) {
      const target = this.world.province(battle.province);

      // Brigades take their own stretch of the frontier rather than all piling
      // onto one point: shift each along the line by its place in the battle.
      const spread = (i: number, n: number, lat: number, ax: number, ay: number): [number, number] => {
        const along = (i - (n - 1) / 2) * CONTACT_FRONTAGE_M * 0.5;
        const [dLon, dLat] = mToDeg(along, lat);
        return [-ay * dLon, ax * dLat];
      };

      battle.attackers.forEach((id, i) => {
        const d = this.sim.byId.get(id);
        if (!d) return;
        const from = this.world.province(d.province);
        const point = this.borderPoint(d.province, battle.province) ?? [
          (from.lon + target.lon) / 2, (from.lat + target.lat) / 2,
        ] as [number, number];
        const c = this.axis(from.lon, from.lat, target.lon, target.lat);
        const [ox, oy] = spread(i, battle.attackers.length, point[1], c[0], c[1]);
        out.set(d.id, { lon: point[0] + ox, lat: point[1] + oy, ax: c[0], ay: c[1] });
      });
      // defenders face the average direction the attack is coming from
      let ax = 0, ay = 0, px = 0, py = 0, n = 0;
      for (const id of battle.attackers) {
        const d = this.sim.byId.get(id);
        if (!d) continue;
        const from = this.world.province(d.province);
        const point = this.borderPoint(d.province, battle.province) ?? [target.lon, target.lat];
        const c = this.axis(target.lon, target.lat, from.lon, from.lat);
        ax += c[0]; ay += c[1]; px += point[0]; py += point[1]; n++;
      }
      if (!n) continue;
      const len = Math.hypot(ax, ay) || 1;
      const dax = ax / len, day = ay / len;
      battle.defenders.forEach((id, i) => {
        const d = this.sim.byId.get(id);
        if (!d) return;
        const along = (i - (battle.defenders.length - 1) / 2) * CONTACT_FRONTAGE_M * 0.5;
        const [dLon, dLat] = mToDeg(along, py / n);
        out.set(d.id, {
          lon: px / n + -day * dLon,
          lat: py / n + dax * dLat,
          ax: dax, ay: day,
        });
      });
    }
    if (this.contactOverride) {
      for (const [id, c] of this.contactOverride) out.set(id, c);
    }
    this.contactCache = out;
    return out;
  }

  private axis(x0: number, y0: number, x1: number, y1: number): [number, number] {
    const lat = (y0 + y1) / 2;
    const dx = (x1 - x0) * Math.cos((lat * Math.PI) / 180);
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }

  /** Midpoint of the border the two provinces share, if they share one. */
  private borderPoint(a: number, b: number): [number, number] | null {
    const segs = this.world.borders.get(this.world.borderKey(a, b));
    if (!segs?.length) return null;
    const mid = segs[Math.floor(segs.length / 2)];
    return [(mid[0][0] + mid[1][0]) / 2, (mid[0][1] + mid[1][1]) / 2];
  }

  /**
   * Who can shoot at whom. Only formations actually in a battle are considered,
   * and a pair only counts if the shooter's weapons reach - a rifle company
   * across 800 m, a tank across three kilometres.
   */
  private buildEngagements() {
    this.engagements = [];
    if (this.map.getZoom() < EFFECTS_ZOOM) return;
    const byDivision = new Map<number, Marker[]>();
    for (const m of this.markers) {
      if (!m.subunit || m.alpha < 0.3) continue;
      const list = byDivision.get(m.divisions[0].id) ?? [];
      list.push(m);
      byDivision.set(m.divisions[0].id, list);
    }
    let pairs = 0;
    for (const battle of this.sim.battles.values()) {
      for (const aId of battle.attackers) {
        const shooters = byDivision.get(aId);
        if (!shooters) continue;
        const tpl = TEMPLATES[this.sim.byId.get(aId)!.template];
        for (const dId of battle.defenders) {
          const targets = byDivision.get(dId);
          if (!targets) continue;
          for (const s of shooters) {
            // nearest enemy sub-unit this one can actually reach
            let best: Marker | null = null, bestD = Infinity;
            for (const t of targets) {
              const dist = metresBetween([s.lon, s.lat], [t.lon, t.lat]);
              if (dist < bestD) { bestD = dist; best = t; }
            }
            if (!best) continue;
            const direct = bestD <= tpl.range;
            const indirect = !direct && tpl.artillery > 0 && bestD <= tpl.artillery;
            if (!direct && !indirect) continue;
            this.engagements.push({
              from: [s.lon, s.lat], to: [best.lon, best.lat],
              rate: direct ? 3.5 * (1 - bestD / (tpl.range * 1.4)) + 1 : 0.5,
              hot: tpl.range > 1500,
              artillery: indirect || tpl.artillery > 0,
            });
            // and the other way: defenders shoot back
            const dTpl = TEMPLATES[this.sim.byId.get(dId)!.template];
            if (bestD <= dTpl.range) {
              this.engagements.push({
                from: [best.lon, best.lat], to: [s.lon, s.lat],
                rate: 3.0 * (1 - bestD / (dTpl.range * 1.4)) + 1,
                hot: dTpl.range > 1500,
                artillery: false,
              });
            }
            if (++pairs > 140) return;
          }
        }
      }
    }
  }

  /** Mark a province as having just been taken. */
  flashCapture(province: number, color: string) {
    const p = this.world.province(province);
    if (!p) return;
    this.flashes.push({ lon: p.lon, lat: p.lat, color, t: 0 });
    if (this.flashes.length > 40) this.flashes.shift();
  }

  /** Advance effects and let the firing lines shoot. */
  tick(dt: number) {
    this.contactCache = null;                 // the sim has moved on
    this.easePositions(dt);
    this.effects.update(dt);
    let n = 0;
    for (const f of this.flashes) { f.t += dt; if (f.t < 2.2) this.flashes[n++] = f; }
    this.flashes.length = n;
    const zoom = this.map.getZoom();
    if (!this.visible || zoom < EFFECTS_ZOOM) return;
    const closeness = Math.min(1, (zoom - EFFECTS_ZOOM) / 3.5);
    for (const e of this.engagements) {
      if (Math.random() < e.rate * dt * (0.35 + 0.65 * closeness)) {
        this.effects.fire(e.from, e.to, e.hot);
        if (Math.random() < 0.5) this.effects.burst(e.to, false);
      }
      if (e.artillery && Math.random() < dt * 0.22 * closeness) {
        const [dLon, dLat] = mToDeg(220, e.to[1]);
        this.effects.burst([
          e.to[0] + (Math.random() - 0.5) * dLon * 2,
          e.to[1] + (Math.random() - 0.5) * dLat * 2,
        ], true);
      }
    }
  }

  /**
   * On a globe, half the world faces away from you. MapLibre still projects
   * those coordinates to screen positions, so without this every counter on
   * the far side bleeds through the planet.
   */
  private occluded(lon: number, lat: number): boolean {
    if (!this.globe) return false;
    const c = this.map.getCenter();
    const rad = Math.PI / 180;
    const cos = Math.sin(c.lat * rad) * Math.sin(lat * rad)
      + Math.cos(c.lat * rad) * Math.cos(lat * rad) * Math.cos((lon - c.lng) * rad);
    // anything more than about 84 degrees from the point facing us is over the horizon
    return cos < 0.1;
  }

  draw() {
    const ctx = this.ctx;
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    ctx.clearRect(0, 0, w, h);
    if (!this.visible) { if (this.showPlans) this.drawPlans(ctx); return; }

    for (const m of this.markers) {
      const p = this.map.project([m.lon, m.lat]);
      m.x = p.x; m.y = p.y;
    }

    this.drawLinks(ctx);
    this.drawAir(ctx);
    this.drawOrders(ctx);

    if (this.map.getZoom() >= EFFECTS_ZOOM) {
      const lat = this.map.getCenter().lat;
      const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** this.map.getZoom();
      this.effects.draw(ctx, (c) => this.map.project(c), mPerPx);
    }

    for (const m of this.markers) {
      if (m.x < -70 || m.y < -70 || m.x > w + 70 || m.y > h + 70) continue;
      if (this.occluded(m.lon, m.lat)) continue;
      this.drawCounter(ctx, m);
    }
    for (const battle of this.sim.battles.values()) this.drawBattle(ctx, battle);
    this.drawFlashes(ctx);
    this.drawMarquee(ctx);
    // plans last: an order should read over the units carrying it out
    if (this.showPlans) this.drawPlans(ctx);
  }

  /** Player-drawn plans: fronts to hold, axes to attack along, lines to fall back to. */
  private drawPlans(ctx: CanvasRenderingContext2D) {
    const store = this.plans;
    if (!store) return;
    for (const plan of store.plans) this.drawPlan(ctx, plan, false);
    if (store.draft && store.draft.points.length) {
      this.drawPlan(ctx, store.draft, true);
    }
  }

  private drawPlan(ctx: CanvasRenderingContext2D, plan: Plan, draft: boolean) {
    const style = PLAN_STYLE[plan.kind];
    const pts = plan.points.map((c) => this.map.project(c));
    if (draft && this.draftCursor) pts.push(this.map.project(this.draftCursor));
    if (pts.length < 2) {
      if (pts.length === 1) {
        ctx.save();
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      return;
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = draft ? 0.75 : 1;

    // dark casing keeps the line readable over any terrain
    ctx.strokeStyle = 'rgba(18,14,10,0.6)';
    ctx.lineWidth = plan.kind === 'invasion' ? 7 : 3.4;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();

    ctx.strokeStyle = style.color;
    ctx.lineWidth = plan.kind === 'invasion' ? 3.5 : 1.6;
    ctx.globalAlpha = plan.kind === 'invasion' ? ctx.globalAlpha : ctx.globalAlpha * 0.85;
    if (plan.kind === 'fallback') ctx.setLineDash([9, 6]);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);

    // a front gets hatch marks on the enemy side; an invasion gets an arrowhead
    if (plan.kind === 'front') {
      // fine, widely spaced ticks on the enemy side - a survey mark on the
      // ground rather than a row of teeth
      ctx.lineWidth = 1.2;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const step = 26;
        for (let d = step / 2; d < len; d += step) {
          const t = d / len;
          const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + nx * 3.5, y + ny * 3.5);
          ctx.stroke();
        }
      }
    } else if (plan.kind === 'invasion') {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - 15 * Math.cos(ang - 0.42), b.y - 15 * Math.sin(ang - 0.42));
      ctx.lineTo(b.x - 10 * Math.cos(ang), b.y - 10 * Math.sin(ang));
      ctx.lineTo(b.x - 15 * Math.cos(ang + 0.42), b.y - 15 * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
    }

    if (!draft) {
      const mid = pts[Math.floor(pts.length / 2)];
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(12,10,8,0.75)';
      const label = `${plan.label}${plan.assigned.length ? ` · ${plan.assigned.length}` : ''}`;
      const wpx = ctx.measureText(label).width + 10;
      ctx.fillRect(mid.x - wpx / 2, mid.y - 20, wpx, 13);
      ctx.fillStyle = style.color;
      ctx.fillText(label, mid.x, mid.y - 10);
    }
    ctx.restore();
  }

  /**
   * Air operations: the reach of a selected wing, and the sorties in the air.
   */
  private drawAir(ctx: CanvasRenderingContext2D) {
    const air = this.air;
    if (!air) return;
    const mPerPx = (156543.03392 * Math.cos((this.map.getCenter().lat * Math.PI) / 180))
      / 2 ** this.map.getZoom();

    // the combat radius of every selected wing
    for (const id of this.selected) {
      const d = this.sim.byId.get(id);
      if (!d || BASED_AT[d.template] !== 'air') continue;
      const base = air.baseOf(d);
      if (!base) continue;
      const centre = this.map.project([base.lon, base.lat]);
      const radiusPx = (combatRadius(d) * 1000) / mPerPx;
      if (radiusPx < 6 || radiusPx > 8000) continue;
      ctx.save();
      ctx.strokeStyle = 'rgba(97,200,255,0.55)';
      ctx.setLineDash([7, 6]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(97,200,255,0.05)';
      ctx.fill();
      // the field itself
      ctx.strokeStyle = 'rgba(97,200,255,0.9)';
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // sorties in the air
    ctx.save();
    for (const mission of air.missions.values()) {
      const a = this.map.project(mission.from);
      const b = this.map.project(mission.to);
      const strike = mission.kind === 'strike';
      ctx.strokeStyle = strike ? 'rgba(255,138,90,0.75)' : 'rgba(97,200,255,0.7)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash(strike ? [10, 5] : [4, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // the target itself
      if (strike) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(b.x - 9, b.y); ctx.lineTo(b.x + 9, b.y);
        ctx.moveTo(b.x, b.y - 9); ctx.lineTo(b.x, b.y + 9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Faint lines from a formation to the units emerging out of it. */
  private drawLinks(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.lineWidth = 1;
    for (const m of this.markers) {
      if (!m.parent) continue;
      const a = this.map.project(m.parent);
      const strength = m.alpha * (1 - m.alpha) * 4;
      if (strength < 0.04) continue;
      ctx.strokeStyle = `rgba(226,214,184,${0.42 * strength})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCounter(ctx: CanvasRenderingContext2D, m: Marker) {
    const kind = m.divisions[0].template;
    const img = counterCanvas(kind, m.color, m.echelon, this.iconStyle);
    const w = COUNTER_W * m.scale, h = COUNTER_H * m.scale;
    const x = m.x - w / 2, y = m.y - h;

    ctx.save();
    ctx.globalAlpha = m.alpha;

    const isSelected = m.subunit
      ? this.selectedUnits.has(m.subunit.id)
      : m.divisions.some((d) => this.selected.has(d.id));
    if (isSelected || this.hovered === m.key) {
      ctx.strokeStyle = isSelected ? '#ffd479' : 'rgba(242,227,189,0.75)';
      ctx.lineWidth = isSelected ? 2 : 1.2;
      ctx.beginPath();
      ctx.roundRect(x - 3, y - 3, w + 6, h + 6, 3);
      ctx.stroke();
    }

    ctx.drawImage(img, x, y, w, h);

    const org = m.subunit ? m.subunit.org
      : m.divisions.reduce((s, d) => s + d.org, 0) / m.divisions.length;
    const str = m.subunit ? m.subunit.strength
      : m.divisions.reduce((s, d) => s + d.strength, 0) / m.divisions.length;
    const by = y + h + 1.5;
    ctx.fillStyle = 'rgba(12,10,8,0.75)';
    ctx.fillRect(x, by, w, 4 * m.scale);
    ctx.fillStyle = '#d9b74a';
    ctx.fillRect(x, by, w * org, 2 * m.scale);
    ctx.fillStyle = '#6fa860';
    ctx.fillRect(x, by + 2 * m.scale, w * str, 2 * m.scale);

    if (m.subunit?.objective) {
      const to = this.map.project(m.subunit.objective);
      ctx.strokeStyle = 'rgba(255,212,121,0.8)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (!m.subunit && m.divisions.length > 1) {
      ctx.fillStyle = 'rgba(16,13,10,0.85)';
      ctx.beginPath();
      ctx.arc(x + w, y, 7 * m.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f0e4c8';
      ctx.font = `600 ${8 * m.scale}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.divisions.length), x + w, y + 0.5);
    }
    ctx.restore();
  }

  /**
   * Movement arrows, in the wargame idiom: a thick shaft along the route the
   * formation is actually taking, filled in behind it as it advances, so the
   * arrow doubles as a progress bar. Formations heading for the same place are
   * drawn as one arrow labelled with their number.
   */
  private drawOrders(ctx: CanvasRenderingContext2D) {
    const groups = new Map<string, { divisions: Division[]; route: [number, number][]; progress: number; color: string; selected: boolean }>();

    for (const d of this.scn.divisions) {
      if (!d.route || d.route.length < 2 || !d.target) continue;
      const mine = d.owner === this.playerId;
      const selected = this.selected.has(d.id);
      if (!mine && !selected) continue;               // your arrows, plus anything you have selected
      const key = `${d.owner}:${d.target[0].toFixed(2)},${d.target[1].toFixed(2)}`;
      const g = groups.get(key);
      if (g) {
        g.divisions.push(d);
        g.progress += d.progress;
        g.selected = g.selected || selected;
        if ((d.routeKm ?? 0) > (g.route.length ? 0 : 0)) { /* keep the first route */ }
      } else {
        groups.set(key, {
          divisions: [d], route: d.route, progress: d.progress,
          color: this.scn.nations.get(d.owner)?.color ?? '#c8a15c', selected,
        });
      }
    }

    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    let drawn = 0;
    for (const g of groups.values()) {
      if (drawn > 90) break;
      const pts = g.route.map((c) => this.map.project(c));
      // skip arrows entirely off screen
      if (!pts.some((p) => p.x > -80 && p.y > -80 && p.x < w + 80 && p.y < h + 80)) continue;
      drawn++;
      this.drawArrow(ctx, pts, g.progress / g.divisions.length, g.color, g.divisions.length, g.selected);
    }
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D,
    pts: { x: number; y: number }[],
    progress: number,
    color: string,
    count: number,
    selected: boolean,
  ) {
    if (pts.length < 2) return;
    const width = selected ? 9 : 7;
    const trace = (from: number, to: number) => {
      ctx.beginPath();
      ctx.moveTo(pts[from].x, pts[from].y);
      for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i].x, pts[i].y);
    };

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // shaft casing, then the empty part of the bar
    trace(0, pts.length - 1);
    ctx.strokeStyle = 'rgba(12,10,8,0.8)';
    ctx.lineWidth = width + 3;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(30,34,38,0.85)';
    ctx.lineWidth = width;
    ctx.stroke();

    // the filled portion: how far the formation has actually got
    const total = this.polylineLength(pts);
    let want = Math.max(0, Math.min(1, progress)) * total;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = selected ? 8 : 4;
    ctx.globalAlpha = 1;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length && want > 0; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (want >= seg) {
        ctx.lineTo(pts[i].x, pts[i].y);
        want -= seg;
      } else {
        const k = seg > 0 ? want / seg : 0;
        ctx.lineTo(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k,
          pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k);
        want = 0;
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // a bright lip at the head of the fill, so progress reads at a glance
    if (progress > 0.01 && progress < 0.99) {
      const at = this.pointAt(pts, progress);
      ctx.fillStyle = 'rgba(255,246,222,0.95)';
      ctx.beginPath();
      ctx.arc(at.x, at.y, width * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }

    // head at the objective
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = width * 2.1;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - head * 0.55 * Math.cos(ang), b.y - head * 0.55 * Math.sin(ang));
    ctx.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(14,11,8,0.75)';
    ctx.lineWidth = 1.4;
    ctx.fill();
    ctx.stroke();

    // label, the way a battle plan is annotated
    const mid = pts[Math.floor(pts.length / 2)];
    const label = `${count} ${count > 1 ? 'units' : 'unit'} · ${Math.round(progress * 100)}%`;
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(14,17,20,0.82)';
    ctx.fillRect(mid.x - tw / 2, mid.y - 20, tw, 14);
    ctx.fillStyle = color;
    ctx.fillText(label, mid.x, mid.y - 13);
    ctx.restore();
  }

  /** Point a fraction of the way along a screen-space polyline. */
  private pointAt(pts: { x: number; y: number }[], t: number): { x: number; y: number } {
    let want = t * this.polylineLength(pts);
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (want <= seg) {
        const k = seg > 0 ? want / seg : 0;
        return {
          x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k,
          y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k,
        };
      }
      want -= seg;
    }
    return pts[pts.length - 1];
  }

  private polylineLength(pts: { x: number; y: number }[]): number {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return total;
  }

  /**
   * A battle has to be findable from orbit and legible up close: a pulsing
   * heat bloom sized by how many formations are committed, crossed sabres once
   * they would be big enough to see, and a count of the units engaged.
   */
  private drawBattle(ctx: CanvasRenderingContext2D, battle: Battle) {
    const pr = this.world.province(battle.province);
    if (this.occluded(pr.lon, pr.lat)) return;
    const p = this.map.project([pr.lon, pr.lat]);
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    if (p.x < -80 || p.y < -80 || p.x > w + 80 || p.y > h + 80) return;

    const zoom = this.map.getZoom();
    const committed = battle.attackers.length + battle.defenders.length;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    // shrink with distance: at continental scale a dozen blooms would otherwise
    // merge into one smear across the front
    const scale = zoom < 4 ? 0.5 : zoom < 6 ? 0.72 : 1;
    const bloom = (10 + Math.min(26, committed * 2.4)) * (0.85 + pulse * 0.35) * scale;

    ctx.save();
    ctx.translate(p.x, p.y);

    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, bloom);
    g.addColorStop(0, `rgba(255,150,70,${0.42 + pulse * 0.2})`);
    g.addColorStop(0.45, `rgba(226,90,55,${0.22 + pulse * 0.12})`);
    g.addColorStop(1, 'rgba(200,60,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, bloom, 0, Math.PI * 2);
    ctx.fill();

    if (zoom > 3.4) {
      const r = (7 + Math.min(5, committed * 0.4) + pulse * 1.6) * scale;
      ctx.strokeStyle = '#ffcf9a';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-r, -r); ctx.lineTo(r, r);
      ctx.moveTo(r, -r); ctx.lineTo(-r, r);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(40,16,10,0.8)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    if (zoom > 5.2 && committed > 1) {
      const label = `${committed}`;
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(24,12,8,0.85)';
      ctx.fillRect(-tw / 2, bloom * 0.55, tw, 12);
      ctx.fillStyle = '#ffcf9a';
      ctx.fillText(label, 0, bloom * 0.55 + 6);
    }
    ctx.restore();
  }

  /** The drag rectangle, while a selection is being pulled out. */
  private drawMarquee(ctx: CanvasRenderingContext2D) {
    const box = this.marquee;
    if (!box) return;
    const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0), h = Math.abs(box.y1 - box.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(255,212,121,0.10)';
    ctx.strokeStyle = 'rgba(255,212,121,0.9)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  /** Every marker whose counter falls inside a screen rectangle. */
  markersIn(x0: number, y0: number, x1: number, y1: number): Marker[] {
    const left = Math.min(x0, x1), right = Math.max(x0, x1);
    const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
    const out: Marker[] = [];
    for (const m of this.markers) {
      if (m.alpha < 0.35) continue;
      const h = COUNTER_H * m.scale;
      const cy = m.y - h / 2;
      if (m.x >= left && m.x <= right && cy >= top && cy <= bottom) out.push(m);
    }
    return out;
  }

  /** Ground changing hands: a ring in the new owner's colour. */
  private drawFlashes(ctx: CanvasRenderingContext2D) {
    ctx.save();
    for (const f of this.flashes) {
      const k = f.t / 2.2;
      const p = this.map.project([f.lon, f.lat]);
      const r = 8 + k * 46;
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = (1 - k) ** 1.6;
      ctx.lineWidth = 2.4 * (1 - k) + 0.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  hitTest(x: number, y: number): Marker | null {
    let best: Marker | null = null;
    let bestScore = -Infinity;
    for (const m of this.markers) {
      if (m.alpha < 0.35) continue;             // ignore whatever is fading out
      const w = COUNTER_W * m.scale, h = COUNTER_H * m.scale;
      const dx = x - m.x, dy = y - (m.y - h / 2);
      if (Math.abs(dx) > w / 2 + 4 || Math.abs(dy) > h / 2 + 6) continue;
      const score = m.alpha * 1000 - (dx * dx + dy * dy);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }
}
