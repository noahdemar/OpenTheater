import { Map as MapLibreMap, NavigationControl, addProtocol, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { buildStyle } from './map/style';
import { PoliticalLayer } from './map/political';
import { registerMapImages } from './map/images';
import { UnitOverlay } from './map/units';
import { World } from './game/world';
import { RoadNetwork } from './game/roads';
import {
  applyOrderOfBattle, atWar, buildScenario, considerPeace, garrisonBases, type OobUnit,
} from './game/scenario';
import { clearWorld, resetWorld } from './editor/world';
import { Installations } from './game/installations';
import { AirOperations } from './game/air';
import { ArmyStore } from './game/armies';
import { Production } from './game/production';
import { ArmyBar } from './ui/armybar';
import { ProductionPanel } from './ui/production';
import { Sim } from './game/sim';
import { techById } from './game/tech';
import { Overlays } from './map/overlays';
import { PlanStore, PLAN_STYLE, type PlanKind } from './game/plans';
import { BASED_AT } from './game/types';
import { Demo } from './game/demo';
import { LayersPanel } from './ui/layers';
import { NationPanel } from './ui/nation';
import { hasSave, loadGame, saveGame, savedAt } from './game/save';
import { EditorModel } from './editor/model';
import { EditorPanel } from './editor/panel';
import { EventLog } from './ui/events';
import { TopBar } from './ui/topbar';
import { UnitCard } from './ui/unitcard';
import { TechTree } from './ui/techtree';
import { mountHud } from './ui/hud';

const DEBUG = new URLSearchParams(location.search).has('debug');

// Keep full stacks for anything thrown during startup: renderer errors surface
// asynchronously and the console only shows a truncated line.
const startupErrors: string[] = [];
window.addEventListener('error', (e) => {
  if (startupErrors.length < 20) startupErrors.push(String(e.error?.stack ?? e.message));
});
Object.assign(window as unknown as Record<string, unknown>, { startupErrors });

setWorkerUrl(workerUrl);

addProtocol('pmtiles', new Protocol().tile);

const map = new MapLibreMap({
  container: 'map',
  style: buildStyle('pmtiles://https://data.source.coop/protomaps/openstreetmap/v4.pmtiles'),
  center: [12, 50],
  zoom: 4.2,
  minZoom: 1.4,
  maxZoom: 19,
  hash: true,
  dragRotate: false,
  // pixel readback is only needed when diagnosing rendering, and it costs frames
  canvasContextAttributes: { antialias: true, preserveDrawingBuffer: DEBUG },
  attributionControl: { compact: true, customAttribution: '' },
});
map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
map.touchZoomRotate.disableRotation();

// The map lives in a pane that can change size without the window doing so -
// a window resize listener misses that, and the canvas is left at the old size.
const container = map.getContainer();
new ResizeObserver(() => map.resize()).observe(container);

async function boot() {
  const world = await World.load();
  const scn = buildScenario(world.data);

  // air and naval forces exist only where there is somewhere to base them
  const installations = await Installations.load();
  const based = garrisonBases(
    scn,
    installations.all.filter((i) => i.t === 'air'),
    installations.all.filter((i) => i.t === 'port'),
    (province) => [world.province(province).lon, world.province(province).lat],
  );
  console.log(`[bases] ${JSON.stringify(installations.counts)} -> ${based.wings} air wings, ${based.flotillas} flotillas`);
  const air = new AirOperations(installations);

  // real names and garrisons, where Wikidata knows them. Kept around so the
  // world can be rebuilt from scratch without reloading the page.
  let oobUnits: OobUnit[] = [];
  try {
    const base = import.meta.env.BASE_URL || '/';
    const oob = await fetch(`${base}data/oob.json`, { cache: 'no-store' }).then((r) => r.json());
    oobUnits = oob.units as OobUnit[];
    const applied = applyOrderOfBattle(scn, oobUnits);
    console.log(`[oob] ${applied} formations given real identities from ${oobUnits.length} records`);
  } catch (err) {
    console.warn('[oob] unavailable, formations stay procedural', err);
  }
  let playerId = [...scn.nations.values()].find((n) => n.tag === 'GER')!.id;

  registerMapImages(map);
  const political = new PoliticalLayer(map, world, scn);
  political.add();

  const overlays = new Overlays(map);
  overlays.add();

  const plans = new PlanStore();

  // declared before the simulation, which reports into it
  const events = new EventLog((at) =>
    map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 6.5), duration: 900 }));

  const sim = new Sim(world, scn, {
    onProvinceCaptured: (province, from, to) => {
      political.setProvinceOwner(province);
      political.markFrontlineDirty();
      overlay?.flashCapture(province, scn.nations.get(to)?.color ?? '#ffd479');
      const p = world.province(province);
      if (to === playerId) {
        events.push('gain', `${p.n} taken`, sim.date, [p.lon, p.lat]);
      } else if (from === playerId) {
        events.push('loss', `${p.n} lost to ${scn.nations.get(to)?.name ?? 'the enemy'}`,
          sim.date, [p.lon, p.lat]);
      }
    },
    onStrike: (province, unitsHit) => {
      const p = world.province(province);
      const wingOwner = scn.controller[province];
      if (wingOwner === playerId) return;
      events.push('air', `Air strike on ${p.n} · ${unitsHit} hit`, sim.date, [p.lon, p.lat]);
    },
    onBattleStart: (battle) => {
      if (battle.attackerSide !== playerId && battle.defenderSide !== playerId) return;
      const p = world.province(battle.province);
      const ours = battle.attackerSide === playerId;
      events.push('battle', `${ours ? 'Attacking' : 'Attacked at'} ${p.n}`, sim.date, [p.lon, p.lat]);
    },
  });

  // industry: a nation builds where its biggest victory point is
  const capitalOf = (nation: number) => {
    let best = -1, bestVp = -1;
    for (const [province, vp] of scn.victoryPoints) {
      if (scn.controller[province] !== nation) continue;
      if (vp > bestVp) { bestVp = vp; best = province; }
    }
    if (best >= 0) return best;
    const fallback = scn.controller.findIndex((c) => c === nation);
    return fallback >= 0 ? fallback : 0;
  };
  const production = new Production(scn, capitalOf);
  const armies = new ArmyStore(scn);

  // eslint-disable-next-line prefer-const -- referenced by the capture hook above
  var overlay = new UnitOverlay(map, world, scn, sim);
  overlay.plans = plans;
  overlay.playerId = playerId;
  overlay.air = air;
  sim.playerNation = playerId;
  sim.air = air;
  for (const d of scn.divisions) if (d.template === 'airwing') air.station(d);

  // the road graph is 12 MB, so it loads alongside the game rather than blocking it
  RoadNetwork.load().then((roads) => {
    sim.roads = roads;
    const reached = [...roads.provinceNode].filter((n) => n >= 0).length;
    console.log(`[roads] ${roads.lon.length} nodes, ${reached} provinces on the network`);
  }).catch((err) => console.warn('[roads] unavailable, moving cross-country', err));
  const hud = mountHud(map, world, scn);
  const card = new UnitCard(world, sim);
  const nationPanel = new NationPanel(scn, () => playerId, (msg) => {
    hud.setStatus(msg);
    political.refreshAll();
    events.push('diplomacy', msg, sim.date);
  });
  const industry = new ProductionPanel(production, world, () => playerId);
  const tech = new TechTree(() => scn.nations.get(playerId), (id) => {
    const n = scn.nations.get(playerId)!;
    n.researching = { id, progress: 0 };
    tech.render();
  });
  const bar = new TopBar(sim, scn, () => playerId, (id) => {
    playerId = id;
    overlay.playerId = id;
    sim.playerNation = id;
    tech.render();
    bar.update();
  }, () => { demo.running ? demo.stop() : demo.start(); }, () => industry.toggle(),
     () => doSave(), () => doLoad(), () => hasSave(), () => editor.toggle());

  /**
   * Globe or flat map. The counters live on a canvas above the map, so the
   * overlay has to know which one it is drawing over in order to hide the
   * hemisphere facing away.
   */
  const setGlobe = (on: boolean) => {
    map.setProjection({ type: on ? 'globe' : 'mercator' });
    overlay.globe = on;
    if (on && map.getZoom() > 5.5) map.easeTo({ zoom: 3.4, duration: 900 });
    overlay.draw();
  };

  const layers = new LayersPanel((id, on) => {
    if (layers.isOverlay(id)) { overlays.toggle(id, on); return; }
    switch (id) {
      case 'political':
        for (const l of ['provinces/fill', 'provinces/outline']) {
          map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
        }
        break;
      case 'frontline':
        for (const l of ['frontline/glow', 'frontline/band', 'frontline/line']) {
          map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
        }
        break;
      case 'units': overlay.visible = on; break;
      case 'nato': overlay.iconStyle = on ? 'nato' : 'pictorial'; break;
      case 'globe': setGlobe(on); break;
      case 'plans': overlay.showPlans = on; break;
    }
    overlay.draw();
  });

  // apply the panel's defaults so what it shows is what the map is doing
  for (const id of ['bases', 'airfields', 'ports'] as const) overlays.toggle(id, layers.get(id));

  const armyBar = new ArmyBar(armies, () => playerId, {
    select: (divisions) => {
      overlay.selected = new Set(divisions.map((d) => d.id));
      overlay.selectedUnits.clear();
      political.setSelected(divisions.map((d) => d.province));
      card.clear();
      overlay.rebuild();
      overlay.draw();
      hud.setStatus(`${divisions.length} formation${divisions.length === 1 ? '' : 's'} selected`);
    },
    assign: (army) => {
      const chosen = [...overlay.selected]
        .map((id) => sim.byId.get(id)!)
        .filter((d) => d && d.owner === playerId);
      if (!chosen.length) { hud.setStatus('select formations first, then right click an army'); return; }
      const { added, rejected } = armies.assign(army, chosen);
      hud.setStatus(rejected
        ? `${added} assigned to ${army.name}; ${rejected} refused (command limit or not yours)`
        : `${added} formation${added === 1 ? '' : 's'} assigned to ${army.name}`);
    },
    created: (army) => hud.setStatus(`${army.name} raised under ${army.general}`),
  });

  document.getElementById('hud')!.append(
    bar.el, card.el, tech.el, layers.el, nationPanel.el, industry.el, armyBar.el, events.el);

  // --- the set piece --------------------------------------------------------
  const demo = new Demo(map, world, scn, sim, plans, {
    cinematic: (on) => {
      // clear the desk while the set piece runs, so only the map is on screen
      document.getElementById('hud')!.classList.toggle('cinematic', on);
    },
    onSetup: (summary) => hud.setStatus(summary),
    rebuildForces: () => {
      overlay.rebuildHierarchy();
      political.rebuildFrontline();
    },
  });

  // --- interaction ---------------------------------------------------------
  let selectedMarker: ReturnType<UnitOverlay['hitTest']> = null;

  /**
   * Which province is under a screen point.
   *
   * Uses the world's own spatial index rather than the renderer, so the UI and
   * the simulation always agree about which province a point is in.
   */
  const provinceAt = (x: number, y: number): number | null => {
    const ll = map.unproject([x, y]);
    if (!isFinite(ll.lng) || !isFinite(ll.lat)) return null;
    return world.provinceAt(ll.lng, ll.lat);
  };

  // Mouse moves arrive far faster than frames; coalesce them and only touch
  // the map or the DOM when what is under the cursor actually changes.
  let hoverPoint: { x: number; y: number } | null = null;
  let hoverQueued = false;
  let lastHoverProvince: number | null = null;
  let lastHoverMarker: string | null = null;

  const applyHover = () => {
    hoverQueued = false;
    if (!hoverPoint) return;
    const marker = overlay.hitTest(hoverPoint.x, hoverPoint.y);
    const markerKey = marker?.key ?? null;
    if (markerKey !== lastHoverMarker) {
      lastHoverMarker = markerKey;
      overlay.hovered = markerKey;
      map.getCanvas().style.cursor = marker ? 'pointer' : '';
      overlay.draw();
    }
    const province = marker ? null : provinceAt(hoverPoint.x, hoverPoint.y);
    if (province !== lastHoverProvince) {
      lastHoverProvince = province;
      political.setHover(province);
      hud.setProvince(province);
    }
  };

  map.on('mousemove', (e) => {
    if (plans.draft) {
      overlay.draftCursor = [e.lngLat.lng, e.lngLat.lat];
      overlay.draw();
      return;
    }
    hoverPoint = { x: e.point.x, y: e.point.y };
    if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(applyHover); }
  });

  // --- shift-drag a box to select every formation inside it ------------------
  // Panning is the gesture you use constantly, so it keeps the plain left drag.
  // Box selection is held behind shift, which means the two never contend for
  // the same drag and the map never stutters at the start of a pan.
  const canvas = map.getCanvas();
  let marqueeStart: { x: number; y: number } | null = null;

  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || plans.draft || !ev.shiftKey) return;
    marqueeStart = { x: ev.offsetX, y: ev.offsetY };
    map.dragPan.disable();
    overlay.marquee = { x0: ev.offsetX, y0: ev.offsetY, x1: ev.offsetX, y1: ev.offsetY };
  });

  canvas.addEventListener('mousemove', (ev) => {
    if (!marqueeStart) return;
    overlay.marquee = { x0: marqueeStart.x, y0: marqueeStart.y, x1: ev.offsetX, y1: ev.offsetY };
    overlay.draw();
  });

  const endMarquee = (ev: MouseEvent) => {
    if (!marqueeStart) return;
    const box = overlay.marquee;
    marqueeStart = null;
    overlay.marquee = null;
    map.dragPan.enable();
    if (!box) return;

    const picked = overlay.markersIn(box.x0, box.y0, ev.offsetX, ev.offsetY)
      .filter((mk) => mk.owner === playerId);
    const divisions = [...new Set(picked.flatMap((mk) => mk.divisions))];
    overlay.selectedUnits = new Set(picked.filter((mk) => mk.subunit).map((mk) => mk.subunit!.id));
    overlay.selected = new Set(divisions.map((d) => d.id));
    political.setSelected(divisions.map((d) => d.province));
    if (picked.length) {
      selectedMarker = picked[0];
      card.show(picked[0], playerId);
      hud.setStatus(`${divisions.length} formation${divisions.length === 1 ? '' : 's'} selected`);
    } else {
      card.clear();
    }
    overlay.rebuild();
    overlay.draw();
  };
  canvas.addEventListener('mouseup', endMarquee);
  canvas.addEventListener('mouseleave', () => {
    if (marqueeStart) map.dragPan.enable();
    marqueeStart = null;
    overlay.marquee = null;
    overlay.draw();
  });

  map.on('click', (e) => {
    // the editor owns the map while it is painting or placing
    if (editor.open && (paintNation || placingNode)) {
      const province = provinceAt(e.point.x, e.point.y);
      if (province != null && editor.placeAt(province)) {
        political.refreshAll();
        overlay.draw();
        return;
      }
    }

    // drawing a plan swallows clicks until the line is finished
    if (plans.draft) {
      plans.addPoint(e.lngLat.lng, e.lngLat.lat);
      overlay.draw();
      return;
    }

    // left click selects, and nothing else
    const marker = overlay.hitTest(e.point.x, e.point.y);
    if (marker) {
      selectedMarker = marker;
      overlay.selectedUnits = marker.subunit ? new Set([marker.subunit.id]) : new Set();
      overlay.selected = new Set(marker.divisions.map((d) => d.id));
      political.setSelected(marker.divisions.map((d) => d.province));
      card.show(marker, playerId);
      nationPanel.clear();
      overlay.draw();
      return;
    }

    // empty ground: drop the selection and show whoever holds this province
    selectedMarker = null;
    overlay.selected.clear();
    overlay.selectedUnits.clear();
    political.setSelected([]);
    card.clear();
    const province = provinceAt(e.point.x, e.point.y);
    if (province != null) nationPanel.show(scn.controller[province]);
    else nationPanel.clear();
    overlay.draw();
  });

  // right click issues orders to whatever is selected
  map.on('contextmenu', (e) => {
    e.preventDefault();
    if (plans.draft) return;

    if (overlay.selectedUnits.size) {
      const owned = overlay.markers.filter((mk) =>
        mk.subunit && overlay.selectedUnits.has(mk.subunit.id) && mk.owner === playerId);
      if (owned.length) {
        for (const mk of owned) sim.orderSubunit(mk.subunit!, [e.lngLat.lng, e.lngLat.lat]);
        overlay.rebuild();
        overlay.draw();
        return;
      }
    }

    const province = provinceAt(e.point.x, e.point.y);
    if (province == null || !overlay.selected.size) return;
    const mine = [...overlay.selected]
      .map((id) => sim.byId.get(id)!)
      .filter((d) => d && d.owner === playerId);
    if (!mine.length) { hud.setStatus('those are not your formations'); return; }

    // Air wings do not march: a right click is a sortie, and it has to be
    // inside the wing's combat radius.
    const wings = mine.filter((d) => d.template === 'airwing');
    if (wings.length) {
      const at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      let flown = 0, ferried = 0, outOfRange = 0;
      for (const d of wings) {
        const mission = air.order(d, at, province,
          (field) => field.p >= 0 && !atWar(scn, d.owner, scn.controller[field.p]));
        if (!mission) outOfRange++;
        else if (mission.kind === 'ferry') ferried++;
        else flown++;
      }
      const parts = [];
      if (flown) parts.push(`${flown} strike sortie${flown > 1 ? 's' : ''}`);
      if (ferried) parts.push(`${ferried} ferrying to a new field`);
      if (outOfRange) parts.push(`${outOfRange} out of range`);
      hud.setStatus(parts.join(' · '));
      overlay.draw();
      if (wings.length === mine.length) return;
    }

    // a flotilla needs a port to enter
    const ground: typeof mine = [];
    const refused: string[] = [];
    const missing = new Set<string>();
    for (const d of mine.filter((x) => x.template !== 'airwing')) {
      const needs = BASED_AT[d.template];
      if (!needs) { ground.push(d); continue; }
      // Provinces are small now, so an airfield you can see may sit just over a
      // provincial line. Accept any installation close to where you clicked.
      const near = installations.has(province, needs)
        || !!installations.nearest(e.lngLat.lng, e.lngLat.lat, needs, 0.35);
      if (near) ground.push(d);
      else { refused.push(d.name); missing.add(needs === 'air' ? 'airfield' : 'port'); }
    }
    if (ground.length) {
      // ground troops march to the exact spot; air and naval to their base
      const air = ground.filter((d) => BASED_AT[d.template]);
      const land = ground.filter((d) => !BASED_AT[d.template]);
      if (land.length) sim.moveTo(land, [e.lngLat.lng, e.lngLat.lat]);
      for (const d of air) {
        const kind = BASED_AT[d.template]!;
        const base = installations.in(province, kind)[0]
          ?? installations.nearest(e.lngLat.lng, e.lngLat.lat, kind, 0.35);
        sim.moveTo([d], base ? [base.lon, base.lat] : [e.lngLat.lng, e.lngLat.lat]);
      }
    }
    const where = world.province(province).n;
    hud.setStatus(refused.length
      ? `${where} has no ${[...missing].join(' or ')} — ${refused.length} formation${refused.length > 1 ? 's' : ''} held back`
      : `${ground.length} formation${ground.length > 1 ? 's' : ''} ordered to ${where}`);
    overlay.draw();
  });

  map.on('dblclick', (e) => {
    if (!plans.draft) return;
    e.preventDefault();
    finishPlan();
  });

  function startPlan(kind: PlanKind) {
    plans.start(kind, playerId);
    overlay.draftCursor = null;
    map.getCanvas().style.cursor = 'crosshair';
    hud.setStatus(`drawing ${PLAN_STYLE[kind].label} — click to add points, Enter to finish, Esc to cancel`);
  }

  function finishPlan() {
    const plan = plans.finish();
    overlay.draftCursor = null;
    map.getCanvas().style.cursor = '';
    if (plan) {
      const mine = [...overlay.selected].map((id) => sim.byId.get(id)!)
        .filter((d) => d && d.owner === playerId);
      if (mine.length) {
        plans.assign(plan, mine);
        // each formation gets its own station on the line, not a province centre
        const stations = PlanStore.stations(plan, mine.length);
        mine.forEach((d, i) => sim.moveTo([d], stations[i]));
        hud.setStatus(`${plan.label}: ${mine.length} formations assigned`);
      } else {
        hud.setStatus(`${plan.label} drawn — select units, then draw again to assign them`);
      }
    } else {
      hud.setStatus('');
    }
    overlay.draw();
  }

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'f' || e.key === 'F') { startPlan('front'); return; }
    if (e.key === 'i' || e.key === 'I') { startPlan('invasion'); return; }
    if (e.key === 'b' || e.key === 'B') { startPlan('fallback'); return; }
    if (e.key === 'Enter' && plans.draft) { finishPlan(); return; }
    if (e.key === 'p' || e.key === 'P') { layers.toggle('political'); return; }
    if (e.key === 'n' || e.key === 'N') { layers.toggle('nato'); return; }
    if (e.key === 'g' || e.key === 'G') { layers.toggle('globe'); return; }
    if (e.key === 'e' || e.key === 'E') { editor.toggle(); return; }
    if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey) { doSave(); return; }
    if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey) { doLoad(); return; }
    if (e.key === 'c' || e.key === 'C') {
      if (!overlay.selected.size) { hud.setStatus('select a formation first'); return; }
      setFollowing(!following);
      return;
    }
    if (e.key === 'd' || e.key === 'D') {
      if (demo.running) demo.stop(); else demo.start();
      return;
    }
    if (e.key === 'u' || e.key === 'U') { layers.toggle('units'); return; }
    if (e.code === 'Space') { e.preventDefault(); sim.speed = sim.speed ? 0 : 2; bar.update(); }
    if (e.key >= '1' && e.key <= '5') { sim.speed = Number(e.key); bar.update(); }
    if (e.key === 't' || e.key === 'T') tech.toggle();
    if (e.key === 'b' && e.shiftKey) { industry.toggle(); return; }
    if (e.key === 'Escape') {
      if (plans.draft) {
        plans.cancel();
        overlay.draftCursor = null;
        map.getCanvas().style.cursor = '';
        hud.setStatus('');
        overlay.draw();
        return;
      }
      overlay.selected.clear(); overlay.selectedUnits.clear();
      political.setSelected([]); card.clear(); tech.toggle(false); industry.toggle(false);
      setFollowing(false);
    }
  });

  // --- scenario editor ------------------------------------------------------
  const editorModel = new EditorModel();
  let paintNation: string | null = null;
  let placingNode: string | null = null;

  /** Everything that has to be rebuilt when the world is replaced wholesale. */
  const afterWorldChange = () => {
    overlay.selected.clear();
    overlay.selectedUnits.clear();
    political.setSelected([]);
    political.refreshAll();
    political.rebuildFrontline();
    overlay.rebuildHierarchy();
    overlay.rebuild();
    overlay.draw();
    card.clear();
    nationPanel.clear();
    events.clear();
    armyBar.render();
    industry.render();
    bar.refreshNations();
    bar.update();
  };

  const editor = new EditorPanel(editorModel, {
    provinceName: (id) => world.province(id)?.n ?? '—',
    onPaintNation: (tag) => { paintNation = tag; },
    onPlaceNode: (id) => { placingNode = id; },
    status: (text) => hud.setStatus(text),
    worldSummary: () => ({
      nations: scn.nations.size,
      divisions: scn.divisions.length,
      owned: scn.controller.reduce((n, c) => n + (c >= 0 ? 1 : 0), 0),
    }),
    onClearWorld: () => {
      clearWorld({ scn, sim, armies, plans, production });
      playerId = -1;
      overlay.playerId = -1;
      sim.playerNation = -1;
      afterWorldChange();
      hud.setStatus('world cleared — build nations, paint their ground, then apply');
    },
    onResetWorld: () => {
      const r = resetWorld(
        { scn, sim, armies, plans, production },
        world.data, installations, oobUnits,
        (p) => [world.province(p).lon, world.province(p).lat],
      );
      const first = [...scn.nations.values()].find((n) => n.tag === 'GER')
        ?? [...scn.nations.values()][0];
      playerId = first?.id ?? -1;
      overlay.playerId = playerId;
      sim.playerNation = playerId;
      for (const d of scn.divisions) if (d.template === 'airwing') air.station(d);
      afterWorldChange();
      hud.setStatus(`scenario reset · ${r.nations} nations · ${r.divisions} formations`);
    },
    onCommit: () => {
      let nextId = Math.max(0, ...scn.divisions.map((d) => d.id)) + 1;
      const r = editorModel.commit(scn, () => nextId++, (p) =>
        [world.province(p).lon, world.province(p).lat]);
      // a freshly built world needs someone to play
      if (playerId < 0) {
        const mine = [...scn.nations.values()].find((n) => editorModel.nations.some((c) => c.tag === n.tag));
        if (mine) { playerId = mine.id; overlay.playerId = mine.id; sim.playerNation = mine.id; }
      }
      for (const [id] of scn.nations) production.addNation(id);
      afterWorldChange();
      hud.setStatus(
        `scenario applied · ${r.nations} nations · ${r.provinces} provinces · ${r.units} formations`);
    },
  });
  document.getElementById('hud')!.append(editor.el);

  // --- saving ---------------------------------------------------------------
  const applyLoadedState = () => {
    overlay.rebuildHierarchy();
    overlay.selected.clear();
    overlay.selectedUnits.clear();
    political.setSelected([]);
    political.refreshAll();
    card.clear();
    events.clear();
    armyBar.render();
    industry.render();
    bar.update();
    overlay.rebuild();
    overlay.draw();
  };

  const doSave = () => {
    const r = saveGame(scn, sim, armies, production, playerId);
    hud.setStatus(r.ok
      ? `saved · ${(r.bytes / 1e6).toFixed(2)} MB`
      : `could not save: ${r.error}`);
  };

  const doLoad = () => {
    const r = loadGame(scn, sim, armies, production);
    if (!r.ok) { hud.setStatus(`could not load: ${r.error}`); return; }
    if (r.playerId !== undefined) {
      playerId = r.playerId;
      overlay.playerId = playerId;
      sim.playerNation = playerId;
    }
    applyLoadedState();
    hud.setStatus(`loaded the game saved ${savedAt()?.slice(0, 16).replace('T', ' ') ?? ''}`);
  };

  // an automatic save every couple of minutes, so a refresh is never fatal
  setInterval(() => { if (sim.speed > 0) saveGame(scn, sim, armies, production, playerId); }, 120_000);

  // --- camera ---------------------------------------------------------------
  // Following keeps the selection centred without taking the map away from you:
  // touching the map turns it off.
  let following = false;
  const setFollowing = (on: boolean) => {
    following = on;
    hud.setStatus(on ? 'camera following selection — drag the map or press C to stop' : '');
  };
  map.on('dragstart', () => { if (following) setFollowing(false); });

  const followStep = () => {
    if (!following || !overlay.selected.size) return;
    let lon = 0, lat = 0, n = 0;
    for (const id of overlay.selected) {
      const d = sim.byId.get(id);
      if (!d) continue;
      const [x, y] = overlay.position(d);
      lon += x; lat += y; n++;
    }
    if (!n) return;
    const target: [number, number] = [lon / n, lat / n];
    const here = map.getCenter();
    const dx = target[0] - here.lng, dy = target[1] - here.lat;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    // ease rather than snap, so the map glides with the unit
    map.setCenter([here.lng + dx * 0.12, here.lat + dy * 0.12]);
  };

  // --- main loop -----------------------------------------------------------
  let last = performance.now();
  let sinceRebuild = 0;
  let sinceUi = 0;
  let sinceFront = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const before = sim.date.getTime();
    sim.update(dt);
    const elapsedDays = (sim.date.getTime() - before) / 86_400_000;
    if (elapsedDays > 0) {
      production.tick(elapsedDays, (p) => [world.province(p).lon, world.province(p).lat], (d) => {
        if (d.owner === playerId) {
          hud.setStatus(`${d.name} joins the order of battle`);
          const p = world.province(d.province);
          events.push('build', `${d.name} ready`, sim.date, [p.lon, p.lat]);
        }
        overlay.rebuildHierarchy();
      });
    }
    overlay.tick(dt);
    followStep();
    sinceRebuild += dt;
    if (sinceRebuild > 0.1) { overlay.rebuild(); sinceRebuild = 0; }
    overlay.draw();
    sinceFront += dt;
    if (sinceFront > 0.4) { political.flush(); sinceFront = 0; }
    sinceUi += dt;
    if (sinceUi > 0.25) {
      bar.update();
      armyBar.render();
      if (selectedMarker) {
        const live = overlay.markers.find((m) => m.key === selectedMarker!.key);
        if (live) card.show(live, playerId);
      }
      tech.render();
      industry.render();
      sinceUi = 0;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  map.on('move', () => { overlay.rebuild(); overlay.draw(); });
  map.on('zoom', () => hud.setBand());

  // foreign governments answer standing peace offers
  setInterval(() => {
    for (const [key, from] of [...scn.peaceOffers]) {
      const [a, b] = key.split(':').map(Number);
      const other = from === a ? b : a;
      if (other === playerId) continue;                 // the player answers for themselves
      const nation = scn.nations.get(other);
      if (!nation) continue;
      const held = scn.controller.reduce((s, c) => s + (c === other ? 1 : 0), 0);
      const core = scn.owner.reduce((s, c) => s + (c === other ? 1 : 0), 0);
      const losing = held < core * 0.85;
      if (considerPeace(scn, other, from, losing)) {
        scn.wars.delete(key);
        scn.peaceOffers.delete(key);
        hud.setStatus(`${nation.name} accepts peace.`);
        events.push('diplomacy', `${nation.name} accepts peace`, sim.date);
        political.refreshAll();
        nationPanel.refresh();
      }
    }
  }, 3000);

  // research completion
  setInterval(() => {
    for (const n of scn.nations.values()) {
      if (!n.researching) continue;
      const t = techById.get(n.researching.id);
      if (t && n.researching.progress >= t.days) {
        n.techs.add(t.id);
        n.researching = null;
        if (n.id === playerId) events.push('research', `${t.name} researched`, sim.date);
      }
    }
  }, 500);

  Object.assign(window as unknown as Record<string, unknown>,
    { map, world, scn, sim, overlay, plans, overlays, layers, demo, political,
      installations, production, armies, air, editor, editorModel });
  document.body.dataset.ready = '1';
}

map.on('load', () => { boot().catch((err) => console.error('[boot]', err)); });
map.on('error', (e) => console.error('[map]', e.error?.message ?? e));
