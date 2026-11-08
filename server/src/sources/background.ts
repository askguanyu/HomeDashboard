import fs from 'node:fs';
import path from 'node:path';

/**
 * Hourly rotating wallpapers from the NASA Image Library API (free, no key, public domain).
 * A curated set of dark space queries builds a candidate pool once a day;
 * the current hour's image is chosen deterministically: index = floor(now/1h) % pool.
 * Bytes are downloaded server-side (try ~large, fall back to original link) and kept
 * in data/backgrounds/ (LRU) so the kiosk browser never hits the internet and the
 * wallpaper keeps working offline.
 */

export interface BgItem {
  id: string;
  title: string;
  credit: string;
  date: string; // YYYY-MM-DD
  url: string; // primary download candidate
  urls?: string[]; // ordered fallback candidates (Bing resolutions)
  query: string; // pool provenance label (NASA search term / 'bing')
}

interface Pool {
  builtAt: number;
  items: BgItem[];
}

const QUERIES = [
  'nebula',
  'galaxy',
  'aurora',
  'milky way',
  'moon',
  'star cluster',
  'deep space',
  'earth at night',
  'jupiter',
  'saturn',
  'andromeda',
  'supernova remnant',
];
const PER_QUERY_CAP = 60;
const POOL_TTL_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const MAX_KEEP_FILES = 48;
const UA = 'HomeDashboard/0.1 (personal home display; local aggregation server)';

export function backgroundsDir(root: string): string {
  const d = path.join(root, 'data', 'backgrounds');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

let pool: Pool | null = null;
let building: Promise<Pool> | null = null;

function readPersisted(dir: string): Pool | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'pool.json'), 'utf8')) as Pool;
    if (Array.isArray(j.items) && j.items.length > 0 && typeof j.builtAt === 'number') return j;
  } catch {
    /* no/broken cache file */
  }
  return null;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function searchNasa(q: string): Promise<BgItem[]> {
  const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image&year_start=2005`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`NASA search "${q}" -> HTTP ${r.status}`);
  const j = (await r.json()) as {
    collection?: { items?: Array<{ data?: Array<Record<string, string>>; links?: Array<{ href: string }> }> };
  };
  const out: BgItem[] = [];
  for (const it of j.collection?.items ?? []) {
    if (out.length >= PER_QUERY_CAP) break;
    const d = it?.data?.[0];
    const link = it?.links?.[0];
    if (!d?.nasa_id || !link?.href || !/\.jpe?g($|\?)/i.test(link.href)) continue;
    out.push({
      id: d.nasa_id,
      title: d.title ?? d.nasa_id,
      credit: d.photographer ?? d.creator ?? '',
      date: (d.date_created ?? '').slice(0, 10),
      url: link.href,
      query: q,
    });
  }
  return out;
}

async function buildPool(): Promise<Pool> {
  const results = await Promise.allSettled(QUERIES.map(searchNasa));
  const seen = new Set<string>();
  const items: BgItem[] = [];
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    for (const it of res.value) {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        items.push(it);
      }
    }
  }
  if (items.length === 0) throw new Error('NASA background pool empty (all queries failed)');
  return { builtAt: Date.now(), items: seededShuffle(items, 0x9e3779b9) };
}

async function getPool(root: string): Promise<Pool> {
  const dir = backgroundsDir(root);
  const persisted = readPersisted(dir);
  if (persisted && Date.now() - persisted.builtAt < POOL_TTL_MS) {
    pool = persisted;
    return persisted;
  }
  if (pool && Date.now() - pool.builtAt < POOL_TTL_MS) return pool;

  if (!building) {
    building = buildPool()
      .then((p) => {
        fs.writeFileSync(path.join(dir, 'pool.json'), JSON.stringify(p));
        pool = p;
        return p;
      })
      .finally(() => {
        building = null;
      });
  }
  try {
    return await building;
  } catch {
    if (persisted) return persisted; // offline: stale pool still selects a cached image
    throw new Error('background pool unavailable and no on-disk cache');
  }
}

export interface BgCurrent {
  key: number; // wall-clock hour index
  total: number;
  item: BgItem;
  source: 'nasa' | 'bing';
}

export async function getCurrent(root: string, now = Date.now()): Promise<BgCurrent> {
  const p = await getPool(root);
  const key = Math.floor(now / HOUR_MS);
  const item = p.items[((key % p.items.length) + p.items.length) % p.items.length];
  return { key, total: p.items.length, item, source: 'nasa' };
}

// ---------- Bing daily wallpaper (HPImageArchive, no key) ----------

const BING_TTL_MS = 6 * 3600_000;

interface BingPool {
  builtAt: number;
  market: string;
  items: BgItem[]; // newest first (idx=0 is today's image)
}

let bingPool: BingPool | null = null;
let bingBuilding: Promise<BingPool> | null = null;

async function buildBingPool(market: string): Promise<BingPool> {
  const u = `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=15&mkt=${encodeURIComponent(market)}`;
  const r = await fetch(u, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`bing archive HTTP ${r.status}`);
  const j = (await r.json()) as {
    images?: Array<{ urlbase?: string; enddate?: string; title?: string; copyright?: string }>;
  };
  const items: BgItem[] = (j.images ?? [])
    .filter((im) => im.urlbase && im.enddate)
    .map((im) => {
      const base = `https://www.bing.com${im.urlbase}`;
      const d = im.enddate as string;
      return {
        id: `bing-${im.urlbase!.split('id=')[1]?.split('&')[0] ?? d}`,
        title: im.title ?? '',
        credit: (im.copyright ?? '').split('(')[0]!.trim(),
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        url: `${base}_UHD.jpg`,
        urls: [`${base}_UHD.jpg`, `${base}_1920x1080.jpg`, `${base}_1024x768.jpg`, base],
        query: 'bing',
      };
    });
  if (!items.length) throw new Error('bing archive empty');
  return { builtAt: Date.now(), market, items };
}

async function getBingPool(root: string, market: string): Promise<BingPool> {
  const dir = backgroundsDir(root);
  const file = path.join(dir, `bing-${market}.json`);
  const load = (): BingPool | null => {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8')) as BingPool;
      return p.market === market && Array.isArray(p.items) && p.items.length ? p : null;
    } catch {
      return null;
    }
  };
  const persisted = load();
  if (persisted && Date.now() - persisted.builtAt < BING_TTL_MS) {
    bingPool = persisted;
    return persisted;
  }
  if (bingPool && bingPool.market === market && Date.now() - bingPool.builtAt < BING_TTL_MS) return bingPool;
  if (!bingBuilding) {
    bingBuilding = buildBingPool(market)
      .then((p) => {
        fs.writeFileSync(file, JSON.stringify(p));
        bingPool = p;
        return p;
      })
      .finally(() => {
        bingBuilding = null;
      });
  }
  try {
    return await bingBuilding;
  } catch (e) {
    if (persisted) return persisted; // offline: stale list still selects a cached image
    throw e;
  }
}

/** `bing-daily` = today's image only; `bing-rotate` = hourly rotation over the latest 8 days. */
export async function getBingCurrent(root: string, mode: string, market: string, now = Date.now()): Promise<BgCurrent> {
  const p = await getBingPool(root, market);
  if (mode !== 'bing-rotate') {
    const item = p.items[0];
    return { key: Number(item.date.replaceAll('-', '')), total: 1, item, source: 'bing' };
  }
  const recent = p.items.slice(0, Math.min(8, p.items.length));
  const key = Math.floor(now / HOUR_MS);
  const item = recent[((key % recent.length) + recent.length) % recent.length];
  return { key, total: recent.length, item, source: 'bing' };
}

/** xorshift-style integer hash so consecutive hours jump around the pool. */
function hash32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * `mix`: every hour, pick a library first (all configured libraries equally
 * likely, so the smaller Bing set is not drowned out by the big NASA pool),
 * then a random image inside it. Offline-safe: whichever pools still resolve
 * (persisted lists) keep rotating; a library that fails just drops out.
 */
export async function getMixedCurrent(root: string, market: string, now = Date.now()): Promise<BgCurrent> {
  const key = Math.floor(now / HOUR_MS);
  const [bingRes, nasaRes] = await Promise.allSettled([getBingPool(root, market), getPool(root)]);
  const bingItems =
    bingRes.status === 'fulfilled' ? bingRes.value.items.slice(0, Math.min(8, bingRes.value.items.length)) : [];
  const nasaItems = nasaRes.status === 'fulfilled' ? nasaRes.value.items : [];
  const libs = [bingItems, nasaItems].filter((a) => a.length > 0);
  if (!libs.length) throw new Error('no background sources available');
  const pick = (k: number): [number, number] => {
    const l = hash32(k * 2 + 1) % libs.length;
    return [l, hash32(k * 2 + 2) % libs[l]!.length];
  };
  let [li, ii] = pick(key);
  const [pli, pii] = pick(key - 1);
  if (li === pli && ii === pii) ii = (ii + 1) % libs[li]!.length; // never repeat back-to-back
  const item = libs[li]![ii]!;
  return { key, total: bingItems.length + nasaItems.length, item, source: item.query === 'bing' ? 'bing' : 'nasa' };
}

/** True if `u` looks like a real JPEG (magic bytes), not an error page saved by mistake. */
function isJpeg(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Path to a locally cached jpg for `item`; downloads on first request of that hour. */
export async function getBackgroundFile(root: string, item: BgItem): Promise<string> {
  const dir = backgroundsDir(root);
  const file = path.join(dir, `${item.id}.jpg`);
  const usable = () => fs.existsSync(file) && fs.statSync(file).size > 5_000;
  if (usable()) {
    const t = new Date();
    fs.utimesSync(file, t, t); // LRU touch
    return file;
  }
  // Ordered candidates: explicit list (Bing UHD→1920→…), else NASA ~large upgrade.
  const large = item.url.replace(/~(medium|small)\.jpg$/i, '~large.jpg');
  const candidates = item.urls ?? (large === item.url ? [item.url] : [large, item.url]);
  let lastErr = 'none';
  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA } });
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 5_000 || buf.length > 40_000_000 || !isJpeg(buf)) {
        lastErr = `bad payload ${buf.length}B`;
        continue;
      }
      const tmp = `${file}.tmp`; // atomic land: no 0-byte/corrupt stubs on partial failure
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      cleanupLru(dir, file);
      return file;
    } catch (e) {
      lastErr = String(e);
    }
  }
  if (usable()) return file; // network dead: serve the stale bytes we have
  throw new Error(`background download failed for ${item.id}: ${lastErr}`);
}

function cleanupLru(dir: string, keep: string) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.tmp')) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* busy */
      }
    }
  }
  const jpgs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of jpgs.slice(MAX_KEEP_FILES)) {
    if (f !== keep) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* busy */
      }
    }
  }
}
