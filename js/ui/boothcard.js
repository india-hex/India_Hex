// Booth and polling-location (catchment) cards for the sidebar, and the booth counts every place card
// shows for the election in effect (variable on the map, election chip, or the state's latest).
import { esc } from '../scales.js';
import { units, rawUnitValues, unitExtras } from '../data/units.js';
import { seriesById } from '../lens.js';
import { electionById, detailFor, resultOf } from '../booths.js';

let CTX = null;
const U = () => units();
const X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const FLAG_TEXT = {
  relocated: 'Relocated pin', outside_ac: 'Pin outside its AC (boundary imprecision; kept)', numbering_verified: 'Booth numbering verified',
  is_aux: 'Auxiliary booth', estimated: 'Location estimated (source gap in this AC)', aux_merged: 'Merged auxiliary station',
};

export function initBoothCards(ctx) { CTX = ctx; }

const n = (x) => (x == null ? '–' : Math.round(x).toLocaleString('en-IN'));
const pct = (x) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
const pp = (x) => (x == null ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)} pp`);

/** AC, PC and district links of a booth's AC (site units by state and number). */
function placeLinks(el, d) {
  const ac = CTX.act.acOf(el.state, d.ac_no);
  const pc = ac && ac.pc >= 0 ? U().pc[ac.pc] : null;
  const dist = ac && ac.d >= 0 ? U().district[ac.d] : null;
  const out = [];
  out.push(`<span>AC</span>${ac ? `<button data-sel="ac:${ac.id}">${esc(ac.name)} · ${d.ac_no}</button>` : `<b>${esc(d.ac_name)} · ${d.ac_no}</b>`}`);
  out.push(`<span>PC</span>${pc ? `<button data-sel="pc:${pc.id}">${esc(pc.name)} · ${pc.no}</button>` : `<b>${esc(d.pc_name || '')} · ${d.pc_no ?? ''}</b>`}`);
  if (dist) out.push(`<span>District</span><button data-sel="district:${dist.id}">${esc(dist.name)}</button>`);
  return `<div class="meta">${out.join('')}</div>`;
}

/** Leading party, margin, votes and one bar per party (EVM votes, Form 20). */
function resultHTML(el, row) {
  const r = resultOf(el, row);
  if (!r.total) return '<p class="note">No votes recorded here.</p>';
  const parties = el.parties.map((p) => ({ ...p, votes: row[p.id] ?? 0 }));
  const max = Math.max(...parties.map((p) => p.votes), 1);
  const lead = r.lead ? `<i class="sw" style="background:${r.lead.color}"></i><b>${esc(r.lead.label)}</b> ${r.lead.id === 'tie' ? '' : 'leads'}` : '';
  const rows = parties.map((p) => `<div class="pbar"><span class="pl">${esc(p.label)}</span><span class="pt"><i style="width:${Math.max(0.6, (p.votes / max) * 100)}%;background:${p.color}"></i></span><span class="pv">${pct(p.votes / r.total)}</span><span class="pn">${n(p.votes)}</span></div>`).join('');
  const kv = [[`Votes${el.electors ? ' (valid)' : ''}`, n(r.total)]];
  if (row.electors != null) {
    kv.push(['Electors', n(row.electors)]);
    if (row.votes_polled != null) kv.push(['Votes polled', n(row.votes_polled)], ['Turnout', pct(row.electors ? row.votes_polled / row.electors : null)]);
  }
  return `<div class="bres"><div class="blead">${lead}${r.margin != null ? `<span class="bmargin">margin ${pp(r.margin)}</span>` : ''}</div>
    <div class="pbars">${rows}</div>
    <div class="kvs">${kv.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')}</div></div>`;
}

function flagsHTML(el, d, b) {
  const bits = Object.entries(el.flag_bits || {}).filter(([bit]) => (b.flags || 0) & +bit).map(([, name]) => name);
  const chips = bits.map((f) => {
    let t = FLAG_TEXT[f] || f.replace(/_/g, ' ');
    if (f === 'relocated' && d.relocated?.[b.uid]) { const [la, lo] = d.relocated[b.uid]; t += ` (originally ${la.toFixed(5)}, ${lo.toFixed(5)})`; }
    return `<span class="flag">${esc(t)}</span>`;
  });
  const method = d.methods?.[b.method];
  if (method) chips.push(`<span class="flag dim">Located by: ${esc(method.replace(/_/g, ' '))}</span>`);
  return chips.length ? `<div class="flags">${chips.join('')}</div>` : '';
}

const NOTE = '<p class="note">EVM votes from Form 20 (booth level). Postal ballots are counted only for whole constituencies, so these figures differ slightly from the official results. The leading party is the bucket with the most votes, not a seat winner; "Others" sums all other candidates.</p>';

/** The selected booth (k = 'b') or polling location (k = 'c'). */
export async function boothBand(st) {
  const sel = st.booth;
  const el = electionById(sel.el);
  if (!el) return '';
  const d = await detailFor(el, sel.ac);
  const head = (kicker) => `<section class="band boothband"><button class="icon close" data-act="closebooth" title="Close">${X}</button>
    <div class="kicker">${kicker} · ${esc(el.state_name)} ${esc(el.label)}</div>`;
  if (!d) return `${head('Polling booth')}<p class="note">The details of this AC could not be loaded.</p></section>`;
  const btn = (b, on = false) => `<button class="bchip${on ? ' on' : ''}" data-act="booth" data-el="${el.id}" data-k="b" data-id="${b.uid}" data-ac="${d.ac_no}">${esc(b.booth)}</button>`;
  if (sel.k === 'b') {
    const b = d.booth.get(sel.id);
    if (!b) return `${head('Polling booth')}<p class="note">Booth not found in this AC.</p></section>`;
    const loc = d.loc.get(b.loc);
    const mates = d.boothsAt(b.loc);
    const aux = /[A-Za-z]$/.test(String(b.booth)) || ((b.flags || 0) & 8);
    const where = mates.length > 1
      ? `<div class="bloc"><div class="lab">${mates.findIndex((x) => x.uid === b.uid) + 1} of ${mates.length} booths at this location</div><div class="bchips">${mates.map((x) => btn(x, x.uid === b.uid)).join('')}</div></div>`
      : '<div class="bloc"><div class="lab">The only booth at this location</div></div>';
    return `${head('Polling booth')}
      <h2 class="title">Booth ${esc(b.booth)}${aux ? ' <small class="tag">auxiliary</small>' : ''}</h2>
      ${placeLinks(el, d)}
      ${resultHTML(el, b)}
      ${flagsHTML(el, d, b)}
      ${where}
      ${loc ? `<button class="textbtn" data-act="booth" data-el="${el.id}" data-k="c" data-id="${b.loc}" data-ac="${d.ac_no}">The area this location serves →</button>` : ''}
      ${NOTE}</section>`;
  }
  const loc = d.loc.get(sel.id);
  if (!loc) return `${head('Polling location')}<p class="note">This location has no booth rows in the detail file.</p></section>`;
  const mates = d.boothsAt(loc.loc);
  const area = d.area(loc.loc);
  const tot = area ? area[0] + area[1] : 0;
  const areaTxt = area && tot ? `<div class="kvs"><span>Area <b>${tot >= 100 ? `${(tot / 100).toFixed(tot >= 1000 ? 0 : 1)} km²` : `${tot.toFixed(0)} ha`}</b></span><span>Empty land <b>${pct(area[1] / tot)}</b></span></div>` : '';
  return `${head('Polling location')}
    <h2 class="title">${mates.length} booth${mates.length === 1 ? '' : 's'} at this location</h2>
    ${placeLinks(el, d)}
    ${areaTxt}
    ${resultHTML(el, loc)}
    <div class="bloc"><div class="lab">Booths here</div><div class="bchips">${mates.map((x) => btn(x)).join('')}</div></div>
    <p class="note">The area is where the people these booths serve live (100 m population cells assigned to the nearest balanced location); a pin can lie outside it. Lighter parts are empty land.</p>
    ${NOTE}</section>`;
}

// ---- booth counts in place cards (R9) ---------------------------------------------------------------
/**
 * Booths, electors and valid votes of a selected unit for the election in effect, as key figures:
 * [{s, v, last, tag, note}] (empty outside Karnataka and Bihar).
 */
export async function electionFigs(sel) {
  if (!sel) return [];
  const u = U()[sel.level][sel.id];
  const el = CTX.act.electionHere(sel.level === 'state' ? sel.id : u.st);
  if (!el) return [];
  const out = [];
  for (const b of ['booths', 'electors', 'votes']) {
    const s = seriesById(`${el.prefix}${b}`);
    if (!s || !s.years.includes(el.year)) continue;
    const vals = await rawUnitValues(s.id, sel.level, el.year);
    const v = vals ? vals[sel.id] : null;
    let note = '';
    if (b === 'booths') {
      const x = await unitExtras(s.id, sel.level, el.year);
      if (sel.level === 'ac') {
        const loc = x?.extra?.located?.[sel.id]; const unloc = x?.extra?.unlocated?.[sel.id];
        if (v == null) note = 'booth data incomplete';
        else if (!unloc) note = `all ${n(loc)} located`;
        else {
          // booths without coordinates: their votes from the AC's detail file
          const d = await detailFor(el, u.no);
          const votes = d?.unlocated?.votes;
          note = loc ? `located ${n(loc)} · ${n(unloc)} without location${votes ? ` (${n(votes)} votes)` : ''}`
            : `no booth has coordinates (${n(unloc)} booths${votes ? `, ${n(votes)} votes` : ''}): no pins or catchments`;
        }
      } else {
        const k = x?.left?.[sel.id] || 0;
        if (v == null) note = 'no AC with complete booth data';
        else if (k) note = `excl. ${k} AC${k === 1 ? '' : 's'} without complete booth data`;
      }
    }
    if (sel.level === 'district' && v != null) note = note ? `${note}; approximate` : 'approximate (ACs grouped by district)';
    out.push({ s, v, v0: null, last: el.year, first: null, tag: `${el.label}`, note });
  }
  return out;
}

/**
 * Booth figures of a hexagon (count of pins in the cell): note for missing data, and "located booths
 * only" in an AC whose booths are not all located.
 */
export async function hexBoothNote(el, s, v, acId) {
  if (!s.id.endsWith('_booths')) return '';
  if (!Number.isFinite(v)) return 'no complete booth data';
  if (acId == null || acId < 0) return '';
  const x = await unitExtras(s.id, 'ac', el.year);
  return x?.extra?.unlocated?.[acId] > 0 ? '(located booths only)' : '';
}
