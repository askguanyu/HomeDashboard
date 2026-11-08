// One-off regeneration of the bundled FOMC schedule from federalreserve.gov
// (official dates are fixed years ahead; re-run once a year when a new year appears).
//   node scripts/gen-fomc.mjs
// Output: server/data/fomc-schedule.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'data', 'fomc-schedule.json');
const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7,
  August: 8, September: 9, October: 10, November: 11, December: 12,
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, Jun: 6, Jul: 7, Aug: 8, Sept: 9, Oct: 10, Nov: 11, Dec: 12,
};
const pad = (n) => String(n).padStart(2, '0');

const r = await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', {
  headers: { 'User-Agent': 'Mozilla/5.0 (schedule fetch; HomeDashboard)' },
});
if (!r.ok) throw new Error(`fomccalendars.htm -> HTTP ${r.status}`);
const h = await r.text();

const heads = [...h.matchAll(/(20\d\d) FOMC Meetings<\/a><\/h4><\/div>/g)];
const out = {};
for (let i = 0; i < heads.length; i++) {
  const year = +heads[i][1];
  const headEnd = heads[i].index + heads[i][0].length;
  const nextFooter = h.indexOf('<div class="panel-footer">', headEnd);
  const seg = h.slice(
    headEnd,
    Math.min(i + 1 < heads.length ? heads[i + 1].index : h.length, nextFooter > 0 ? nextFooter : h.length),
  );
  const meetings = [];
  for (const raw of seg.split(/<div class="[^"]*fomc-meeting"[^>]*>/).slice(1)) {
    const mo = raw.match(/fomc-meeting__month[^>]*><strong>([\w/]+)<\/strong>/);
    const da = raw.match(/fomc-meeting__date[^>]*>([^<]+)</);
    if (!mo || !da) continue;
    const body = da[1].trim(); // "27-28", "17-18*", "1", "22 (notation vote)", "31-1" (spans to next month)
    const press = /Press Conference/.test(raw);
    const sep = body.includes('*');
    const stmt = raw.match(/monetary(\d{8})a/); // only exists once the statement is out
    const vote = /notation vote/i.test(body);

    let start;
    let decision;
    if (stmt) decision = `${stmt[1].slice(0, 4)}-${stmt[1].slice(4, 6)}-${stmt[1].slice(6, 8)}`;
    if (vote) {
      start = decision; // one-day notation vote; decision day is the day itself
    } else {
      const range = body.match(/^(\d{1,2})(?:\s*-\s*(?:(\w+)\s+)?(\d{1,2}))?\*?$/);
      if (!range) continue;
      const moName = mo[1];
      const pair = moName.includes('/') ? moName.split('/') : null; // "Jan/Feb" spans two months
      const m = MONTHS[pair ? pair[0] : moName];
      if (!m) continue;
      const day1 = +range[1];
      let end;
      if (!range[3]) end = `${year}-${pad(m)}-${pad(day1)}`; // single-day meeting
      else if (range[2]) end = `${year}-${pad(MONTHS[range[2]])}-${pad(range[3])}`; // "31 - February 1"
      else if (pair || +range[3] < day1) end = `${year}-${pad(pair ? MONTHS[pair[1]] : m === 12 ? 1 : m + 1)}-${pad(range[3])}`; // "31-1" next month
      else end = `${year}-${pad(m)}-${pad(range[3])}`;
      start = `${year}-${pad(m)}-${pad(day1)}`;
      decision ??= end; // future meetings: last calendar day of the range
    }
    if (!start || !decision) continue;
    meetings.push({ start, decision, press, sep, notation: vote || undefined });
  }
  if (meetings.length >= 4) out[year] = meetings; // guard against a half-parsed block
}

const years = Object.keys(out).sort();
if (years.length < 2) throw new Error('parse produced too few years: ' + years.join(','));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log('wrote', path.relative(ROOT, OUT), '|', years.map((y) => `${y}:${out[y].length}`).join(' '));
