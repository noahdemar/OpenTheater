/**
 * Icons.
 *
 * Lucide (ISC licence) drawn inline as SVG rather than loaded as a font: the
 * panels rebuild their own markup constantly, an inline string costs nothing
 * to stamp out, and `currentColor` means an icon always matches the text it
 * sits beside - including in whichever theme the map is wearing.
 */
import {
  Anchor, Binoculars, ChartColumn, CircleDashed, Crosshair, Factory, Flame,
  FlaskConical, FolderOpen, Globe, Hash, Landmark, Layers as LayersIcon,
  Map as MapIcon, Pause, PencilRuler, Plane, Play, Radio, Route, Save,
  Satellite, Shield, ShieldAlert, Ship, Swords, TrendingDown, TrendingUp,
  Users, X,
} from 'lucide';

type Node = [string, Record<string, string | number>, Node[]?];

const SET = {
  anchor: Anchor,
  binoculars: Binoculars,
  chart: ChartColumn,
  close: X,
  crosshair: Crosshair,
  editor: PencilRuler,
  factory: Factory,
  flame: Flame,
  footprint: CircleDashed,
  globe: Globe,
  hash: Hash,
  landmark: Landmark,
  layers: LayersIcon,
  load: FolderOpen,
  loss: TrendingDown,
  map: MapIcon,
  pause: Pause,
  plane: Plane,
  play: Play,
  radio: Radio,
  route: Route,
  satellite: Satellite,
  save: Save,
  ship: Ship,
  shield: Shield,
  swords: Swords,
  tech: FlaskConical,
  threat: ShieldAlert,
  units: Users,
  win: TrendingUp,
} as const;

export type IconName = keyof typeof SET;

const attrs = (a: Record<string, string | number>) =>
  Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ');

function render(nodes: Node[]): string {
  return nodes.map(([tag, a, kids]) =>
    `<${tag} ${attrs(a)}>${kids ? render(kids) : ''}</${tag}>`).join('');
}

/**
 * One icon, as an SVG string ready to drop into a template. It inherits the
 * surrounding text colour and sits on the text baseline.
 */
export function icon(name: IconName, size = 14): string {
  const nodes = SET[name] as unknown as Node[];
  if (!nodes) return '';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
    + ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true">${render(nodes)}</svg>`;
}
