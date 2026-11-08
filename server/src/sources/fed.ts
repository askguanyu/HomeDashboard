import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * US federal reserve calendar for the calendar widget (free, no key):
 * - FOMC decisions/press conferences: bundled server/data/fomc-schedule.json
 *   (official dates are fixed years ahead; regenerate: node scripts/gen-fomc.mjs).
 * - Officials' speeches/testimony: scraped from federalreserve.gov
 *   /newsevents/{year}-speeches.htm; the detail href embeds the date:
 *   /newsevents/speech/{who}{YYYYMMDD}{x}.htm. Cached data/fed-{year}.json,
 *   refreshed daily, served stale when offline.
 */

export type FedKind = 'fomc' | 'speech';

export interface FedEvent {
  date: string; // YYYY-MM-DD
  kind: FedKind;
  label: string; // short chip text
  title: string; // english title / description (tooltip)
  who?: string; // speech: official slug (powell, waller, ...)
  press?: boolean; // fomc: press conference same day
}

interface FomcMeeting {
  start: string;
  decision: string;
  press: boolean;
  sep: boolean;
  notation?: boolean;
}

const UA = 'HomeDashboard/0.1 (personal home display; local aggregation server)';
const TTL_MS = 7 * 24 * 3600_000; // weekly refresh is plenty (user request)
const EMPTY_TTL_MS = 24 * 3600_000; // listing scraped OK but zero events: background recheck daily
const MISSING_TTL_MS = 7 * 24 * 3600_000; // future-year 404: don't hammer, recheck weekly
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HD_ROOT ? path.resolve(process.env.HD_ROOT) : path.resolve(SELF_DIR, '../../..');
// fomc-schedule.json candidates: dev tree / portable root (HD_ROOT) / bundle
// sibling / cwd (manual `node server.mjs` without HD_ROOT set).
const SCHEDULES = [ROOT, SELF_DIR, process.cwd()].map((r) => path.join(r, 'server', 'data', 'fomc-schedule.json'));

const WHO_CN: Record<string, string> = {
  powell: '鲍威尔',
  williams: '威廉姆斯',
  bowman: '鲍曼',
  waller: '沃勒',
  jefferson: '杰斐逊',
  cook: '库克',
  barr: '巴尔',
  dalbosco: '达尔博斯科',
  goldstein: '戈德斯坦',
  perli: '珀利',
  logan: '洛根',
  george: '乔治',
  harker: '哈克',
  bullard: '布拉德',
  bostic: '博斯蒂克',
  mester: '梅斯特',
  evans: '埃文斯',

}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

let schedule: Record<string, FomcMeeting[]> | null = null;
function readSchedule(): Record<string, FomcMeeting[]> {
  if (!schedule) {
    let parsed: Record<string, FomcMeeting[]> = {};
    for (const f of SCHEDULES) {
      try {
        parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, FomcMeeting[]>;
        break;
      } catch {
        /* try next candidate; if all miss, FOMC chips are absent */
      }
    }
    schedule = parsed;
  }
  return schedule;
}

function fomcEvents(year: number): FedEvent[] {
  const list = readSchedule()[String(year)] ?? [];
  return list.map((m) => ({
    date: m.decision,
    kind: 'fomc' as const,
    label: m.notation ? 'FOMC票决' : 'FOMC',
    title: m.notation
      ? 'FOMC decision by notation vote'
      : `FOMC meeting ${m.start} → ${m.decision}${m.press ? ' · press conference' : ''}${m.sep ? ' · SEP projections' : ''}`,
    press: m.press,
  }));
}

function cacheFile(root: string, year: number): string {
  const d = path.join(root, 'data');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `fed-${year}.json`);
}

async function scrapeSpeeches(year: number): Promise<FedEvent[]> {
  const url = `https://www.federalreserve.gov/newsevents/${year}-speeches.htm`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  // note: the Fed returns the full navigation shell (80KB+) with status 404
  // for years whose schedule isn't published yet -> throw, stay uncached.
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const h = await r.text();
  if (h.length < 20_000) throw new Error(`${url}: page suspiciously small (${h.length}B), not a listing`);
  const byDate = new Map<string, FedEvent>();
  for (const m of h.matchAll(
    /href="(\/newsevents\/(?:speech|testimony)\/([a-z]+?)(20\d\d)(\d\d)(\d\d)[a-z]?\.htm)"[^>]*>(?:<[^>]*>)*([^<]{3,160})/gi,
  )) {
    const who = m[2].toLowerCase();
    const date = `${m[3]}-${m[4]}-${m[5]}`;
    const title = decodeEntities(m[6]);
    if (!title || /^(video|watch|hearing|markup|pdf)$/i.test(title)) continue; // duplicate anchors
    const prev = byDate.get(date);
    if (prev && prev.title.length >= title.length) continue; // keep the descriptive anchor
    byDate.set(date, {
      date,
      kind: 'speech',
      label: `讲话·${WHO_CN[who] ?? who}`,
      title: `${m[1].includes('testimony') ? 'Testimony' : 'Speech'}: ${title}`,
      who,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

interface Cached {
  savedAt: number;
  events: FedEvent[];
  /** listing for this year returned 404 (not published yet) */
  missing?: boolean;
}

function readCache(root: string, year: number): Cached | null {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(root, year), 'utf8')) as Cached;
    if (Array.isArray(c.events)) return c;
  } catch {
    /* none */
  }
  return null;
}

function cacheTtl(c: Cached): number {
  return c.missing ? MISSING_TTL_MS : c.events.length ? TTL_MS : EMPTY_TTL_MS;
}

const refreshing = new Set<number>();

/** Background-only scrape. Request handlers NEVER await this, so a page
 *  refresh only ever reads the local disk cache. */
async function refreshYear(root: string, year: number): Promise<void> {
  if (refreshing.has(year)) return;
  refreshing.add(year);
  try {
    try {
      const speeches = await scrapeSpeeches(year);
      fs.writeFileSync(cacheFile(root, year), JSON.stringify({ savedAt: Date.now(), events: speeches } satisfies Cached));
      console.log(`[fed] ${year}: refreshed ${speeches.length} speeches (next in 7d)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 404/.test(msg)) {
        try {
          fs.writeFileSync(cacheFile(root, year), JSON.stringify({ savedAt: Date.now(), events: [], missing: true } satisfies Cached));
        } catch {
          /* cache dir unwritable: maintenance sweep will retry */
        }
        console.log(`[fed] ${year} listing not published yet (HTTP 404); recheck in 7d`);
      } else console.warn(`[fed] ${year} scrape failed (keeping old cache):`, msg);
    }
  } finally {
    refreshing.delete(year);
  }
}

/** FOMC schedule (built-in, offline) + cached speeches. Synchronous reads only. */
export async function getFedEvents(root: string, year: number): Promise<{ year: number; events: FedEvent[] }> {
  const cache = readCache(root, year);
  if (!cache || Date.now() - cache.savedAt >= cacheTtl(cache)) void refreshYear(root, year); // fire & forget
  const events = [...fomcEvents(year), ...(cache?.events ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return { year, events };
}

/** Startup + daily sweep keeps current/next year fresh; pages never hit the network path. */
export function startFedMaintenance(root: string): void {
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
