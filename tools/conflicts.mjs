/**
 * Ongoing armed conflicts, from Wikipedia.
 *
 * The list is maintained as four wikitext tables, one per intensity band, and
 * each row is a conflict tree (a parent conflict and the wars fought inside
 * it), the states the fighting takes place in, and the death toll. This turns
 * that into `public/data/conflicts.json` for the strategic model.
 *
 * Text and figures are CC BY-SA 4.0, (c) Wikipedia contributors.
 *   node tools/conflicts.mjs
 */
import { writeFile } from 'node:fs/promises';

const PAGE = 'List_of_ongoing_armed_conflicts';
const API = `https://en.wikipedia.org/w/api.php?action=parse&page=${PAGE}&prop=wikitext&format=json&formatversion=2`;

/** Intensity bands, in the same order and colours the article's map uses. */
const TIERS = [
  { id: 'major',    table: 'conflicts10000', label: 'Major war',  color: '#7d1d1d', min: 10000 },
  { id: 'minor',    table: 'conflicts1000',  label: 'Minor war',  color: '#c0392b', min: 1000 },
  { id: 'conflict', table: 'conflicts100',   label: 'Conflict',   color: '#d98324', min: 100 },
  { id: 'skirmish', table: 'conflicts1',     label: 'Skirmishes', color: '#e8c44a', min: 1 },
];

/** Drop <ref>..</ref>, comments and the citation noise inside a cell. */
function clean(s) {
  return s
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{efn[\s\S]*?\}\}/g, '')
    .trim();
}

/** `[[target|shown]]` and `[[target]]` -> the text a reader sees. */
const linkText = (s) => s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');

/** The article of a `[[link]]`, so a conflict can be opened on Wikipedia. */
function firstLink(s) {
  const m = s.match(/\[\[([^\]|#]+)/);
  return m ? m[1].trim().replace(/ /g, '_') : null;
}

/**
 * Split a table row into its cells. Cells start with `|` at the head of a
 * line, but templates and links nest and may themselves contain `|`, so this
 * only breaks at depth zero.
 */
function cells(row) {
  const out = [];
  let depth = 0, cur = '', atLineStart = true;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (row.startsWith('{{', i) || row.startsWith('[[', i)) { depth++; cur += row[i] + row[i + 1]; i++; atLineStart = false; continue; }
    if (row.startsWith('}}', i) || row.startsWith(']]', i)) { depth--; cur += row[i] + row[i + 1]; i++; atLineStart = false; continue; }
    if (c === '\n') { atLineStart = true; cur += c; continue; }
    if (atLineStart && c === '|' && depth <= 0) { out.push(cur); cur = ''; atLineStart = false; continue; }
    if (c !== ' ' && c !== '\t') atLineStart = false;
    cur += c;
  }
  out.push(cur);
  // the leading fragment before the first `|` is row formatting, not a cell
  return out.slice(1).map((c) => clean(c.replace(/^[^|\n]*style="[^"]*"\s*\|/, '')));
}

/** States named by `{{flag|X}}`, `{{flagu|X}}` or a bare wikilink. */
function states(cell) {
  const found = [];
  const push = (n) => {
    const name = n.trim().replace(/^''|''$/g, '');
    if (name && !found.includes(name)) found.push(name);
  };
  for (const m of cell.matchAll(/\{\{\s*flag(?:u|country|icon|deco)?\s*\|\s*([^|}]+)/gi)) push(m[1]);
  if (!found.length) for (const m of cell.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) push(m[1]);
  return found;
}

/** The conflict tree: `*` depth gives the hierarchy of wars inside a row. */
function tree(cell) {
  const nodes = [];
  for (const line of cell.split('\n')) {
    const m = line.match(/^(\*+)\s*(.+)$/);
    if (!m) continue;
    const raw = m[2].trim();
    if (!raw) continue;
    nodes.push({ depth: m[1].length, name: linkText(raw).replace(/\s*\([^()]*since[^()]*\)\s*$/i, '').trim(), article: firstLink(raw) });
  }
  if (!nodes.length) {
    const t = linkText(cell).split('\n')[0].trim();
    if (t) nodes.push({ depth: 1, name: t, article: firstLink(cell) });
  }
  return nodes;
}

/** `{{nts|254000}}-263,000+` and friends -> a low/high pair of numbers. */
function fatalities(cell) {
  const nums = [];
  for (const m of cell.matchAll(/\{\{\s*nts\s*\|\s*([\d,]+)/gi)) nums.push(+m[1].replace(/,/g, ''));
  if (!nums.length) {
    for (const m of clean(cell).matchAll(/(\d[\d,]{2,})/g)) nums.push(+m[1].replace(/,/g, ''));
  }
  if (!nums.length) {
    const small = clean(cell).match(/(\d+)/);
    if (small) nums.push(+small[1]);
  }
  if (!nums.length) return null;
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

function rowsOf(wikitext, tableId) {
  const start = wikitext.indexOf(`id="${tableId}"`);
  if (start < 0) return [];
  const end = wikitext.indexOf('\n|}', start);
  const body = wikitext.slice(start, end < 0 ? undefined : end);
  // the first chunk is the header row
  return body.split(/\n\|-\n/).slice(2);
}

const wikitext = await fetch(API, { headers: { 'user-agent': 'OpenTheater/1.0 (scenario data build)' } })
  .then((r) => r.json()).then((j) => j.parse.wikitext);

const conflicts = [];
for (const tier of TIERS) {
  for (const row of rowsOf(wikitext, tier.table)) {
    const c = cells(row);
    if (c.length < 5) continue;
    const nodes = tree(c[1]);
    if (!nodes.length) continue;
    const root = nodes[0];
    const start = +clean(c[0]).replace(/[^\d]/g, '').slice(0, 4);
    const where = states(c[3]);
    if (!where.length) continue;
    conflicts.push({
      id: (root.article ?? root.name).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, ''),
      name: root.name,
      article: root.article,
      tier: tier.id,
      start: Number.isFinite(start) && start > 1700 ? start : null,
      continent: linkText(clean(c[2])).replace(/[\[\]]/g, '').trim(),
      countries: where,
      theatres: nodes.slice(1).map((n) => ({ name: n.name, article: n.article, depth: n.depth })),
      fatalities: {
        cumulative: fatalities(c[4]),
        prev: c[5] ? fatalities(c[5]) : null,
        current: c[6] ? fatalities(c[6]) : null,
      },
    });
  }
}

const out = {
  source: `https://en.wikipedia.org/wiki/${PAGE}`,
  license: 'CC BY-SA 4.0, Wikipedia contributors',
  retrieved: new Date().toISOString().slice(0, 10),
  tiers: TIERS.map(({ id, label, color, min }) => ({ id, label, color, min })),
  conflicts,
};
await writeFile('public/data/conflicts.json', JSON.stringify(out));

const byTier = {};
for (const c of conflicts) byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;
const countries = new Set(conflicts.flatMap((c) => c.countries));
console.log(`[conflicts] ${conflicts.length} conflicts`, byTier);
console.log(`[conflicts] ${countries.size} states involved, ${conflicts.reduce((n, c) => n + c.theatres.length, 0)} named theatres`);
