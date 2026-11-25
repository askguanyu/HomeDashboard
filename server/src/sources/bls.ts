import fs from 'node:fs';
import path from 'node:path';
import { decodeEntities } from './html.js';

/**
 * Principal US economic data releases for the calendar widget (free, no key):
 * the Bureau of Labor Statistics publishes one plain HTML table per year at
 * https://www.bls.gov/schedule/{year}/home.htm — Date | Time (ET) | Release —
 * laid out roughly two years ahead, with rows like
 *   <td class="date-cell"><p>Friday, October 2, 2026</p></td>
 *   <td class="time-cell"><p>08:30 AM</p></td>
 *   <td class="desc-cell"><p><strong>Employment Situation</strong> for September 2026</p></td>
 * Only the releases the market actually trades on are kept (see KEEP); the other
 * ~50 lines a year (state/metropolitan employment, real earnings, productivity,
 * and the holidays the same table lists) are dropped.
 * Cached data/bls-{year}.json as raw rows, so chip text can be reworded without
 * re-scraping. Refreshed monthly, served stale when offline.
 */

export interface DataEvent {
  date: string; // YYYY-MM-DD
  kind: 'data';
  label: string; // short chip text
  title: string; // tooltip: what it is + which period + clock time
}

/** What the cache stores: the table row minus all presentation. */
interface ReleaseRow {
  date: string; // YYYY-MM-DD
  key: string; // KEEP key (the page's release name, lowercase)
  name: string; // the page's release name, as spelled
  period: string; // "for September 2026"
  time: string; // "08:30", 24-hour Eastern; '' when the page gives none
}

interface Cached {
  savedAt: number;
  rows: ReleaseRow[];
  /** year page fetched fine but yielded no kept rows (layout change) */
  empty?: boolean;
  /** year page 404s: its schedule is not published yet */
  missing?: boolean;
}

const UA = 'HomeDashboard/0.1 (personal home display; local aggregation server)';
const TTL_MS = 30 * 24 * 3600_000; // official dates are fixed ~2 years ahead
const EMPTY_TTL_MS = 24 * 3600_000; // no rows parsed: recheck daily, keep serving old cache
const MISSING_TTL_MS = 7 * 24 * 3600_000; // future-year 404: don't hammer, recheck weekly

/**
 * BLS release names kept, keyed by the page's exact spelling, lowercase.
 * Anything not listed here never reaches the calendar.
 */
const KEEP: Record<string, { label: string; zh: string }> = {
  'employment situation': { label: '非农', zh: '就业状况报告（非农新增与失业率）' },
  'consumer price index': { label: 'CPI', zh: '消费者价格指数' },
  'producer price index': { label: 'PPI', zh: '生产者价格指数' },
  'employment cost index': { label: 'ECI', zh: '就业成本指数（工资增速）' },
  'job openings and labor turnover survey': { label: 'JOLTS', zh: '职位空缺与劳动力流动调查' },
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "08:30 AM" -> "08:30"; the page always prints 12-hour with a space before AM/PM. */
function to24(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d\d)\s*([AP])M$/i);
  if (!m) return '';
  const h = (+m[1] % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0);
  return `${pad(h)}:${m[2]}`;
}

/** Kept rows of a year page. Exported so the scrape can be tested offline. */
export function parseRows(html: string): ReleaseRow[] {
  const out: ReleaseRow[] = [];
  const seen = new Set<string>();
  const row =
    /<td class="date-cell"><p>([^<]+)<\/p><\/td>\s*<td class="time-cell"><p>([^<]*)<\/p><\/td>\s*<td class="desc-cell"><p>([\s\S]*?)<\/p><\/td>/gi;
  for (const m of html.matchAll(row)) {
    const d = m[1].match(/([A-Za-z]+)\s+(\d{1,2}),\s*20(\d\d)/);
    const strong = m[3].match(/<strong>([\s\S]*?)<\/strong>/);
    if (!d || !strong) continue;
    const month = MONTHS[d[1].toLowerCase()];
    const name = decodeEntities(strong[1]);
    const key = name.toLowerCase();
    if (!month || !KEEP[key]) continue;
    const date = `20${d[3]}-${pad(month)}-${pad(+d[2])}`;
    if (seen.has(`${date}|${key}`)) continue; // guard a duplicated block
    seen.add(`${date}|${key}`);
    out.push({
      date,
      key,
      name,
      period: decodeEntities(m[3].slice(m[3].indexOf(strong[0]) + strong[0].length)), // "for September 2026"
      time: to24(decodeEntities(m[2]).trim()),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Row -> chip. Drops rows whose KEEP entry has since been removed. */
function toEvent(r: ReleaseRow): DataEvent | null {
  const spec = KEEP[r.key];
  if (!spec) return null;
  return {
    date: r.date,
    kind: 'data',
    label: spec.label,
    title: `${spec.zh} · ${r.name}${r.period ? ` ${r.period}` : ''} · ${r.time ? `${r.time} 美东时间` : '美东时间'}`,
  };
}

async function scrapeYear(year: number): Promise<ReleaseRow[]> {
  const url = `https://www.bls.gov/schedule/${year}/home.htm`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const h = await r.text();
  // a real year page is ~100KB; a stub or a bot-wall is far smaller
  if (h.length < 20_000) throw new Error(`${url}: page suspiciously small (${h.length}B), not a schedule`);
  return parseRows(h);
}

function cacheFile(root: string, year: number): string {
  const d = path.join(root, 'data');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `bls-${year}.json`);
}

function readCache(root: string, year: number): Cached | null {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(root, year), 'utf8')) as Cached;
    if (Array.isArray(c.rows)) return c; // an older `events`-shaped file is ignored and re-scraped
  } catch {
    /* none */
  }
  return null;
}

function cacheTtl(c: Cached): number {
  return c.missing ? MISSING_TTL_MS : c.rows.length ? TTL_MS : EMPTY_TTL_MS;
}

const refreshing = new Set<number>();
/** In-memory backoff so a moved page or a 404 doesn't re-scrape on every page
 *  load; deliberately not persisted, a restart gets one fresh attempt. */
const attempts = new Map<number, number>();
const FAIL_BACKOFF_MS = 6 * 3600_000;

/** Background-only scrape. Request handlers NEVER await this, so a page
 *  refresh only ever reads the local disk cache. */
async function refreshYear(root: string, year: number): Promise<void> {
  if (refreshing.has(year) || Date.now() - (attempts.get(year) ?? 0) < FAIL_BACKOFF_MS) return;
  refreshing.add(year);
  try {
    const rows = await scrapeYear(year);
    attempts.delete(year);
    fs.writeFileSync(cacheFile(root, year), JSON.stringify({ savedAt: Date.now(), rows } satisfies Cached));
    console.log(`[bls] ${year}: refreshed ${rows.length} data releases (next in 30d)`);
  } catch (err) {
    attempts.set(year, Date.now());
    const msg = err instanceof Error ? err.message : String(err);
    const keep = readCache(root, year); // rows from an earlier success stay authoritative
    try {
      if (keep) {
        console.warn(`[bls] ${year} refresh failed (keeping ${keep.rows.length} cached rows):`, msg);
      } else if (/HTTP 404/.test(msg)) {
        fs.writeFileSync(cacheFile(root, year), JSON.stringify({ savedAt: Date.now(), rows: [], missing: true } satisfies Cached));
        console.log(`[bls] ${year} schedule not published yet (HTTP 404); recheck in 7d`);
      } else {
        fs.writeFileSync(cacheFile(root, year), JSON.stringify({ savedAt: Date.now(), rows: [], empty: true } satisfies Cached));
        console.warn(`[bls] ${year}: parsed no rows; recheck in 24h:`, msg);
      }
    } catch {
      /* cache dir unwritable: the daily sweep will retry */
    }
  } finally {
    refreshing.delete(year);
  }
}

/** Cached data releases. Synchronous disk read only; scrapes run in the background. */
export async function getDataEvents(root: string, year: number): Promise<DataEvent[]> {
  const cache = readCache(root, year);
  if (!cache || Date.now() - cache.savedAt >= cacheTtl(cache)) void refreshYear(root, year); // fire & forget
  return (cache?.rows ?? []).map(toEvent).filter((e): e is DataEvent => e !== null);
}

/** Startup + daily sweep keeps current/next year fresh; pages never hit the network path. */
export function startDataMaintenance(root: string): void {
  const sweep = () => {
    const y = new Date().getFullYear();
    for (const year of [y, y + 1]) {
      const c = readCache(root, year);
      if (!c || Date.now() - c.savedAt >= cacheTtl(c)) void refreshYear(root, year);
    }
  };
  sweep();
  setInterval(sweep, 24 * 3600_000).unref();
}
