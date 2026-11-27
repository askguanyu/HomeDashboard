import fs from 'node:fs';
import path from 'node:path';

/**
 * Kiosk wallpapers from five free, keyless libraries:
 *   nasa       NASA Image Library (public domain, ~7k curated space queries)
 *   bing       Bing daily wallpaper — live feed (today) + community archive mirror (~6k history)
 *   wallhaven  wallhaven.cc SFW photography API (direct CDN urls derived from stable ids)
 *   commons    Wikimedia Commons Quality/Featured tier search (3840px thumbnails, rich credits)
 *   eso        ESO press-image archive (astronomy masters, HEAD size-capped)
 *
 * Each library keeps a persisted *manifest* (data/backgrounds/<name>.json) that a daily
 * refresh appends to, capped and re-shuffled; manifests never expire for selection, only
 * for refresh — so an offline kiosk keeps rotating whatever it already knows. Because
 * every source's file bytes are re-fetchable by the saved id alone, selection is
 * deterministic AND repeat-free: `recent.json` remembers the last ~20 days of hourly
 * picks, and the hour's hash scans forward past them. Bytes download server-side and
 * LRU-live in data/backgrounds/, so the kiosk browser never touches the internet.
 */

export type BgSource = 'nasa' | 'bing' | 'wallhaven' | 'commons' | 'eso';

export interface BgItem {
  id: string;
  title: string;
  credit: string;
  date: string; // YYYY-MM-DD (or '')
  url: string; // primary download candidate
  urls?: string[]; // ordered fallback candidates (primary first); otherwise url only
  query: string; // pool provenance label
  src?: BgSource; // missing on pre-multi-source pool.json files → derived from `query`
  headCheck?: boolean; // HEAD first and skip if Content-Length exceeds maxBytes (ESO masters)
  maxBytes?: number;
}

interface Manifest {
  builtAt: number;
  items: BgItem[];
}

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
const MAX_KEEP_FILES = 96; // LRU cap for cached jpg bytes on disk
const MAX_DOWNLOAD_BYTES = 40_000_000; // hard size guard for any single image
const SEEN_CAP = 500; // recent.json history (~20 days of hourly picks)
const SEEN_LOOKBACK_HOURS = 480; // horizon (20 days) within which no image is ever shown twice
const UA = 'HomeDashboard/0.1 (personal home display; local aggregation server)';

export function backgroundsDir(root: string): string {
  const d = path.join(root, 'data', 'backgrounds');
  fs.mkdirSync(d, { recursive: true });
  return d;
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

/** xorshift-style integer hash so consecutive hours jump around the pool. */
function hash32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const enc = encodeURIComponent;

/**
 * Every fetch is bounded: an unattended kiosk must not let one hung socket stall the
 * hourly selection (undici's default headers timeout is 300 s, far too long here).
 */
const META_TIMEOUT_MS = 20_000;
const HEAD_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 90_000; // a 25 MB ESO master over a slow link still fits

function timedFetch(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Read a source manifest; refresh it when older than `ttlMs`. A STALE manifest is served
 * immediately while the refresh runs in the background — a slow or dead upstream must never
 * stall hourly selection or the index.html preload (Chrome 72 caps the kiosk at 6 sockets to
 * one origin, so a hanging wallpaper route freezes the whole dashboard, not just the art).
 * Only a COLD start (nothing on disk) awaits the build. Refresh merges new items into the
 * persisted ones (dedupe by id, re-shuffle per day, cap); `merge:false` (bing-live) replaces
 * instead, so "today's image" can never be shuffled out by cap-slicing against leftovers.
 * A failed refresh keeps serving the stale manifest, with a 5 min backoff so offline polls
 * don't hammer the internet once a minute.
 */
interface BuildResult {
  items: BgItem[];
  partial?: boolean; // some sub-query failed: retry in PARTIAL_RETRY_MS instead of full TTL
}

const PARTIAL_RETRY_MS = 12 * 3600_000;
const FAIL_BACKOFF_MS = 5 * 60_000;

const building = new Map<string, Promise<BgItem[]>>();
const lastFailAt = new Map<string, number>();
// parsed-manifest memo keyed by mtime: every 60 s poll would otherwise JSON.parse ~5 MB
// of pool.json/bing-archive/etc on each request (the pre-refactor module-level `pool` var).
const manifestCache = new Map<string, { mtimeMs: number; items: BgItem[]; builtAt: number }>();
let tmpSeq = 0;

function refreshManifest(
  dir: string,
  file: string,
  ttlMs: number,
  cap: number,
  build: () => Promise<BuildResult>,
  opts: { merge?: boolean } = {},
): Promise<BgItem[]> {
  const fp = path.join(dir, file);
  const merge = opts.merge !== false;
  let persisted: Manifest | null = null;
  try {
    const mtime = fs.statSync(fp).mtimeMs;
    let memo = manifestCache.get(fp);
    if (!memo || memo.mtimeMs !== mtime) {
      // parse once per on-disk revision (mtime), and normalize legacy shapes in place
      const j = JSON.parse(fs.readFileSync(fp, 'utf8')) as Manifest;
      if (Array.isArray(j.items) && j.items.length && typeof j.builtAt === 'number') {
        for (const it of j.items) {
          if (!it.src) it.src = it.query === 'bing' ? 'bing' : 'nasa'; // legacy pool.json
          // Pre-multi-source NASA items stored only links[0] (often ~small/~thumb): always
          // rebuild the rendition chain from the id embedded in the url — deterministic,
          // upgrades partial chains (e.g. a missing ~orig fallback) with no on-disk wipe.
          {
            const m = it.url.match(/^https?:\/\/images-assets\.nasa\.gov\/image\/([^/]+)\//);
            if (m?.[1]) it.urls = [nasaRendition(m[1], 'large'), nasaRendition(m[1], 'medium'), nasaRendition(m[1], 'orig'), nasaRendition(m[1], 'small'), it.url];
          }
        }
        memo = { mtimeMs: mtime, builtAt: j.builtAt, items: j.items };
        manifestCache.set(fp, memo);
      } else {
        memo = undefined;
        manifestCache.delete(fp);
      }
    }
    if (memo) persisted = { builtAt: memo.builtAt, items: memo.items };
  } catch {
    manifestCache.delete(fp); // absent/corrupt: cold path
  }
  if (persisted && Date.now() - persisted.builtAt < ttlMs) return Promise.resolve(persisted.items);

  const startBuild = (): Promise<BgItem[]> => {
    let p = building.get(fp);
    if (!p) {
      p = (async () => {
        let res: BuildResult;
        try {
          res = await build();
        } catch (err) {
          lastFailAt.set(fp, Date.now());
          if (persisted) return persisted.items; // offline: stale manifest still selects cached images
          throw err instanceof Error ? err : new Error(String(err));
        }
        const base = merge ? [...res.items, ...(persisted?.items ?? [])] : res.items;
        const seenIds = new Set<string>();
        const merged: BgItem[] = [];
        for (const it of base) {
          if (it?.id && !seenIds.has(it.id)) {
            seenIds.add(it.id);
            merged.push(it);
          }
        }
        const items = merge
          ? seededShuffle(merged, hash32(Math.floor(Date.now() / DAY_MS) ^ hash32(fp.length * 7919))).slice(0, cap)
          : merged.slice(0, cap);
        const builtAt = res.partial ? Date.now() - ttlMs + PARTIAL_RETRY_MS : Date.now();
        try {
          // unique staging name + guarded write: two processes (dev + packaged release) on one
          // data dir, or a full/read-only disk, must never corrupt or reject a good manifest.
          const tmp = `${fp}.${process.pid}.${tmpSeq++}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify({ builtAt, items } satisfies Manifest));
          fs.renameSync(tmp, fp);
          manifestCache.set(fp, { mtimeMs: fs.statSync(fp).mtimeMs, items, builtAt });
        } catch {
          /* unwritable disk: serve this build from memory; next refresh will retry */
        }
        return items;
      })().finally(() => building.delete(fp));
      building.set(fp, p);
    }
    return p;
  };

  if (persisted) {
    if (Date.now() - (lastFailAt.get(fp) ?? 0) > FAIL_BACKOFF_MS) void startBuild().catch(() => undefined);
    return Promise.resolve(persisted.items);
  }
  // Cold start: the caller waits, but bounded — a slow first build must not hang the
  // document response (Chrome 72 shows white until the shell arrives); the build keeps
  // running in the background and lands in the manifest for the next poll.
  const p = startBuild();
  return new Promise<BgItem[]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`background ${file}: cold build exceeds ${COLD_BUILD_WAIT_MS} ms`)), COLD_BUILD_WAIT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const COLD_BUILD_WAIT_MS = 6000;

/** Worker pool with polite spacing: bounded concurrency, settled results, optional deadline. */
async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number, gapMs: number, deadlineMs?: number): Promise<Array<PromiseSettledResult<T>>> {
  const out: PromiseSettledResult<T>[] = new Array(tasks.length);
  const deadline = deadlineMs ? Date.now() + deadlineMs : 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      if (deadline && Date.now() > deadline) {
        out[i] = { status: 'rejected', reason: new Error('build deadline exceeded') };
        continue;
      }
      try {
        out[i] = { status: 'fulfilled', value: await tasks[i]!() };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
      await new Promise((r) => setTimeout(r, gapMs));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, () => worker()));
  return out;
}

// ---------- seen log: never repeat inside the lookback window ----------

interface SeenEntry {
  k: number; // hour key
  id: string;
  m?: string; // mode|market tag (missing on legacy entries: matches any tag)
}

function readSeen(dir: string): SeenEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'recent.json'), 'utf8')) as { entries?: SeenEntry[] };
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

function selectItem(items: BgItem[], key: number, entries: SeenEntry[], tag: string): BgItem {
  // Stable inside one hour (and across restarts): this tag's pick for the key is on disk.
  const own = entries.find((e) => e.k === key && (e.m === undefined || e.m === tag));
  if (own) {
    const hit = items.find((i) => i.id === own.id);
    if (hit) return hit;
  }
  // Anti-repeat counts every mode/market's shows: the human sees all of them.
  const recent = new Set(entries.filter((e) => e.k !== key && e.k > key - SEEN_LOOKBACK_HOURS).map((e) => e.id));
  const start = hash32(key * 2 + 1) % items.length;
  for (let s = 0; s < items.length; s++) {
    const it = items[(start + s) % items.length]!;
    if (!recent.has(it.id) || s === items.length - 1) return it; // last resort: allow one repeat
  }
  return items[start]!;
}

function recordPick(dir: string, key: number, id: string, entries: SeenEntry[], tag: string): void {
  const fp = path.join(dir, 'recent.json');
  const i = entries.findIndex((e) => e.k === key && e.m === tag);
  if (i >= 0) {
    if (entries[i]!.id === id) return; // already recorded (poll, preload, restart)
    entries[i] = { k: key, id, m: tag }; // the earlier pick proved undownloadable: supersede it
  } else entries.push({ k: key, id, m: tag });
  entries.sort((a, b) => a.k - b.k);
  try {
    const tmp = `${fp}.${process.pid}.${tmpSeq++}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: entries.slice(-SEEN_CAP) }));
    fs.renameSync(tmp, fp);
  } catch {
    /* cache only; a failed record just weakens the anti-repeat memory */
  }
}

// ---------- bad ids: files that failed to download are skipped in every later pick ----------

const BAD_CAP = 4000;

function readBad(dir: string): Set<string> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'bad.json'), 'utf8')) as { ids?: string[] };
    return new Set(Array.isArray(j.ids) ? j.ids : []);
  } catch {
    return new Set();
  }
}

/** Called by the image route ONLY for isDeadAssetError failures (upstream 404/410), never for outages. */
export function markBackgroundBad(root: string, itemId: string): void {
  const dir = backgroundsDir(root);
  const fp = path.join(dir, 'bad.json');
  let ids: string[] = [];
  try {
    ids = (JSON.parse(fs.readFileSync(fp, 'utf8')) as { ids?: string[] }).ids ?? [];
  } catch {
    /* start fresh */
  }
  if (!ids.includes(itemId)) ids.push(itemId);
  try {
    const tmp = `${fp}.${process.pid}.${tmpSeq++}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids: ids.slice(-BAD_CAP) }));
    fs.renameSync(tmp, fp);
  } catch {
    /* cache only */
  }
}

// ---------- NASA Image Library (public domain, keyless) ----------

// ~30 terms chosen from measured total_hits; no year filter (year_start=2005 used to
// drop ~2x of apollo/hubble/iss results). page_size up to 1000 is accepted; 250 keeps
// each response ~0.5 MB while the most relevant hits come first.
const NASA_QUERIES = [
  'webb', 'james webb', 'hubble', 'nebula', 'galaxy', 'aurora', 'milky way', 'moon',
  'mars', 'jupiter', 'saturn', 'star cluster', 'deep space', 'earth at night', 'supernova',
  'black hole', 'comet', 'iss', 'apollo', 'perseverance', 'pleiades', 'orion nebula',
  'sun', 'andromeda', 'exoplanet', 'asteroid', 'artemis', 'solar dynamics observatory',
  'universe', 'telescope',
];
const NASA_PER_QUERY = 250;
const NASA_TTL_MS = 3 * DAY_MS;
const NASA_CAP = 7000;

const nasaRendition = (id: string, size: string): string =>
  `https://images-assets.nasa.gov/image/${id}/${id}~${size}.jpg`;

async function buildNasaPool(): Promise<BuildResult> {
  const results = await Promise.allSettled(
    NASA_QUERIES.map(async (q) => {
      const url = `https://images-api.nasa.gov/search?q=${enc(q)}&media_type=image&page=1&page_size=${NASA_PER_QUERY}`;
      const r = await timedFetch(url, META_TIMEOUT_MS);
      if (!r.ok) throw new Error(`NASA search "${q}" -> HTTP ${r.status}`);
      const j = (await r.json()) as {
        collection?: { items?: Array<{ data?: Array<Record<string, string>>; links?: Array<{ href: string }> }> };
      };
      const out: BgItem[] = [];
      for (const it of j.collection?.items ?? []) {
        const d = it?.data?.[0];
        const link = it?.links?.[0]?.href ?? '';
        if (!d?.nasa_id || out.length >= NASA_PER_QUERY) continue;
        // links[0] is often ~medium/~small/~thumb, so derive the chain from the id, best
        // quality first: ~large (1920px) → ~medium → ~orig (full scan, rare fallback for
        // old film-scan assets that lack web renditions) → ~small → whatever the API gave.
        const urls = [
          nasaRendition(d.nasa_id, 'large'),
          nasaRendition(d.nasa_id, 'medium'),
          nasaRendition(d.nasa_id, 'orig'),
          nasaRendition(d.nasa_id, 'small'),
          link,
        ].filter((u, i, a) => u && a.indexOf(u) === i);
        out.push({
          id: d.nasa_id,
          title: d.title ?? d.nasa_id,
          credit: d.photographer ?? d.creator ?? '',
          date: (d.date_created ?? '').slice(0, 10),
          url: urls[0]!,
          urls,
          query: q,
          src: 'nasa',
        });
      }
      return out;
    }),
  );
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!items.length) throw new Error('NASA background pool empty (all queries failed)');
  return { items, partial: results.some((r) => r.status === 'rejected') };
}

const nasaPool = (dir: string): Promise<BgItem[]> =>
  refreshManifest(dir, 'pool.json', NASA_TTL_MS, NASA_CAP, buildNasaPool); // keep the pre-multi-source filename

// ---------- Bing: live daily feed + deep community archive mirror ----------

const BING_LIVE_TTL_MS = 6 * 3600_000;
const BING_ARCHIVE_TTL_MS = DAY_MS;
const BING_ARCHIVE_CAP = 6000;

// npanuhin/Bing-Wallpaper-Archive mirrors ~16 years of Bing wallpapers as one committed
// JSON per market; image bytes still come from Bing's own CDN via the per-entry id.
const BING_MIRROR_MARKETS: Record<string, [string, string]> = {
  'en-US': ['US', 'en'],
  'zh-CN': ['CN', 'zh'],
};

async function buildBingLivePool(market: string): Promise<BuildResult> {
  const u = `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=15&mkt=${enc(market)}`;
  const r = await timedFetch(u, META_TIMEOUT_MS);
  if (!r.ok) throw new Error(`bing live HTTP ${r.status}`);
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
        src: 'bing' as BgSource,
      };
    });
  if (!items.length) throw new Error('bing live archive empty');
  return { items };
}

async function buildBingArchivePool(market: string): Promise<BuildResult> {
  const [mkt, lang] = BING_MIRROR_MARKETS[market] ?? ['ROW', 'en'];
  const u = `https://raw.githubusercontent.com/npanuhin/Bing-Wallpaper-Archive/master/api/${mkt}/${lang}.json`;
  const r = await timedFetch(u, META_TIMEOUT_MS);
  if (!r.ok) throw new Error(`bing mirror HTTP ${r.status}`);
  const arr = (await r.json()) as Array<{
    date?: string;
    title?: string;
    copyright?: string;
    bing_url?: string | null;
    url?: string;
  }>;
  const items: BgItem[] = [];
  for (const e of arr ?? []) {
    if (!e?.date || e.date < '2019') continue; // pre-2019 originals dip below 1920px
    let tok = '';
    if (e.bing_url) {
      // e.g. https://bing.com/th?id=OHR.FaceCanyon_EN-US6254374163_UHD.jpg  (or _1920x1080.jpg)
      tok = String(e.bing_url).match(/[?&]id=(.+?)_(?:UHD|\d+x\d+|\d{3,4})\.jpg$/i)?.[1] ?? '';
    }
    const base = tok ? `https://www.bing.com/th?id=${tok}` : '';
    const urls = base ? [`${base}_UHD.jpg`, `${base}_1920x1080.jpg`, `${base}_1024x768.jpg`] : [];
    if (e.url) urls.push(e.url); // maintainer's date-keyed self-host: the only source for old entries
    if (!urls.length) continue;
    items.push({
      id: tok ? `bing-${tok}` : `bingm-${mkt}-${e.date}`,
      title: e.title ?? '',
      credit: (e.copyright ?? '').replace(/^\s*©\s*/, '').replace(/\s*©\s*$/, '').trim(),
      date: e.date,
      url: urls[0]!,
      urls,
      query: 'bing',
      src: 'bing',
    });
  }
  if (!items.length) throw new Error('bing mirror produced no items');
  return { items };
}

// merge:false — the live feed is a sliding window, accumulating leftovers would let
// cap-slicing evict today's image (bing-daily depends on it being present).
const bingLivePool = (dir: string, market: string): Promise<BgItem[]> =>
  refreshManifest(dir, `bing-${market}.json`, BING_LIVE_TTL_MS, 15, () => buildBingLivePool(market), { merge: false });
// Markets without a mirror file: the ROW fallback's `_ROW` id tokens don't match the live
// feed's market tokens, so merging it would show the same photo twice — skip it instead.
const bingArchivePool = (dir: string, market: string): Promise<BgItem[]> =>
  BING_MIRROR_MARKETS[market] || market === 'ROW'
    ? refreshManifest(dir, `bing-archive-${market}.json`, BING_ARCHIVE_TTL_MS, BING_ARCHIVE_CAP, () =>
        buildBingArchivePool(market),
      )
    : Promise.resolve([]);

// ---------- Wallhaven (SFW photography, keyless API; bytes = deterministic from id) ----------

const WH_TTL_MS = 3 * DAY_MS; // sorting=random hands us new ids on every refresh
const WH_CAP = 3000;
const WH_QUERIES = ['aurora', 'space', 'stars', 'milky way', 'nebula', 'mountains', 'water', 'night', 'earth', 'forest'];

async function buildWallhavenPool(): Promise<BuildResult> {
  const base = 'https://wallhaven.cc/api/v1/search?categories=100&purity=100&atleast=2560x1440&ratios=16x9';
  const urls = [
    ...WH_QUERIES.map((q) => `${base}&q=${enc(q)}&sorting=random&page=1`),
    // quality floor: most-favorited photography of the past year (editorially ranked by the community)
    `${base}&sorting=toplist&topRange=1y&page=1`,
    `${base}&sorting=toplist&topRange=1y&page=2`,
  ];
  const results = await Promise.allSettled(
    urls.map(async (u) => {
      const r = await timedFetch(u, META_TIMEOUT_MS);
      if (!r.ok) throw new Error(`wallhaven HTTP ${r.status}`);
      const j = (await r.json()) as { data?: Array<Record<string, never>> };
      return j.data ?? [];
    }),
  );
  const items: BgItem[] = [];
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    for (const w of res.value) {
      const id = String(w.id ?? '');
      const wpath = String(w.path ?? '');
      if (!id || !wpath) continue;
      if (w.purity !== 'sfw') continue; // defensive: purity=100 already requests SFW only
      if (w.file_type !== 'image/jpeg') continue; // skip PNG (often 8-16 MB) to keep downloads and the JPEG cache simple
      if (Number(w.file_size) > 12_000_000) continue;
      if (Number(w.dimension_x) < 2560) continue;
      items.push({
        id: `wh-${id}`,
        title: '', // wallhaven search carries no titles; the credit names the library instead
        credit: 'Wallhaven.cc',
        date: String(w.created_at ?? '').slice(0, 10),
        url: wpath,
        urls: [wpath],
        query: 'wallhaven',
        src: 'wallhaven',
      });
    }
  }
  if (!items.length) throw new Error('wallhaven pool empty');
  return { items, partial: results.some((r) => r.status === 'rejected') };
}

const wallhavenPool = (dir: string): Promise<BgItem[]> =>
  refreshManifest(dir, 'wallhaven.json', WH_TTL_MS, WH_CAP, buildWallhavenPool);

// ---------- Wikimedia Commons (Quality/Featured tier search; 3840px thumbs, CC credits) ----------

const WC_TTL_MS = 7 * DAY_MS;
const WC_CAP = 3000;
const WC_TERMS = [
  'aurora', 'nebula', 'galaxy', 'milky way', 'moon', 'sunset', 'lightning',
  'mountains night', 'waterfall', 'stars', 'earth from space', 'ice', 'coral reef', 'volcano',
];
const WC_CATEGORIES = ['Quality images', 'Featured pictures on Wikimedia Commons'];

async function searchCommons(term: string, category: string, offset: number): Promise<BgItem[]> {
  // generator=search with incategory scoping: relevance-ranked (categorymembers would be
  // alphabetical — page 1 of "Quality images" is windmills), and filemime filters to JPEG
  // so the pool never wastes slots on PNG/TIFF/WebM (the download guard would reject them).
  // NOTE: do NOT quote multi-word terms — Commons matches full phrases literally and
  // "mountains night"/"earth from space" would return zero files (unquoted: 186/49048).
  const srch = `${term} incategory:"${category}" filemime:image/jpeg`;
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search' +
    `&gsrnamespace=6&gsrlimit=50&gsroffset=${offset}&gsrsearch=${enc(srch)}` +
    '&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata' +
    '&iiextmetadatafilter=Artist%7CObjectName%7CLicenseShortName&iiurlwidth=2560';
  const r = await timedFetch(url, META_TIMEOUT_MS);
  if (!r.ok) throw new Error(`commons "${term}" -> HTTP ${r.status}`);
  const j = (await r.json()) as {
    query?: { pages?: Record<string, { pageid?: number; title?: string; imageinfo?: Array<Record<string, any>> }> };
  };
  const out: BgItem[] = [];
  for (const p of Object.values(j.query?.pages ?? {})) {
    const ii = p.imageinfo?.[0];
    if (!p.pageid || !ii?.thumburl || ii.mime !== 'image/jpeg') continue;
    // The delivered bitmap follows the *path* (`3840px-...`), not thumbwidth (a CSS hint).
    // Requiring original width >= 2560 keeps the fallback (original-as-thumb on small
    // files) from ever pulling a multi-100 MB master: the 40 MB download cap is the last guard.
    if (Number(ii.width) < 2560 || Number(ii.width) < Number(ii.height)) continue;
    const thumb = String(ii.thumburl).split('?')[0]!; // drop the ?utm_* params the API appends
    const filename = String(p.title ?? '').replace(/^File:/, '');
    const meta = ii.extmetadata ?? {};
    const title = stripHtml(String(meta.ObjectName?.value ?? '')) || filename.replace(/_/g, ' ').replace(/\.\w+$/, '');
    const artist = stripHtml(String(meta.Artist?.value ?? ''));
    const lic = stripHtml(String(meta.LicenseShortName?.value ?? ''));
    out.push({
      id: `wc-${p.pageid}`, // pageid is stable and filesystem-safe; File: titles are not
      title: title.slice(0, 90),
      credit: [artist.slice(0, 70), lic].filter(Boolean).join(' · ') || 'Wikimedia Commons',
      date: '',
      url: thumb,
      urls: [thumb, `https://commons.wikimedia.org/wiki/Special:FilePath/${enc(filename)}?width=2560`],
      query: 'commons',
      src: 'commons',
    });
  }
  return out;
}

async function buildCommonsPool(): Promise<BuildResult> {
  // Relevance search is the same top-50 every call, so each rebuild slides the window
  // deeper (day-rotation) and the manifest accumulates genuinely new files over weeks.
  const offset = (Math.floor(Date.now() / DAY_MS) % 7) * 50;
  // WMF answers 28 parallel api.php searches with ~50% HTTP 429; two workers at 450 ms
  // spacing measured zero throttling. Failures mark the build partial (retry in 12 h).
  const results = await runPool(
    WC_TERMS.flatMap((t) => WC_CATEGORIES.map((c) => () => searchCommons(t, c, offset))),
    2,
    450,
    100_000,
  );
  // 28 spaced searches every WC_TTL_MS: WMF's image host documents 600k req/min and
  // api.php returned no rate-limit headers at all, so this is noise — just keep builds rare.
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!items.length) throw new Error('commons pool empty');
  return { items, partial: results.some((r) => r.status === 'rejected') };
}

const commonsPool = (dir: string): Promise<BgItem[]> =>
  refreshManifest(dir, 'commons.json', WC_TTL_MS, WC_CAP, buildCommonsPool);

// ---------- ESO archive (press-quality astronomy; HTML-embedded array, no JSON API) ----------

const ESO_TTL_MS = 7 * DAY_MS;
const ESO_CAP = 150; // small but top-tier set; keeps the credit enrichment bounded
// Verified live page depths (2026-11): requesting a page past the end 404s, which would
// silently drop the shallowest category (blackholes, 4 pages) on most rotation days.
const ESO_CATEGORIES: Record<string, number> = { nebulae: 12, galaxies: 15, stars: 17, blackholes: 4, solarsystem: 12, paranal: 72 };
const ESO_MAX_BYTES = 25_000_000; // `large` is the untrimmed master: median ~4 MB, max 155 MB

interface EsoEntry {
  id: string;
  title: string;
  width: number;
  height: number;
}

function parseEsoListing(html: string): EsoEntry[] {
  const block = html.match(/var images = \[([\s\S]*?)\n\s*\];/)?.[1] ?? '';
  const out: EsoEntry[] = [];
  for (const m of block.matchAll(/\{\s*id:\s*'([^']+)'[\s\S]*?title:\s*'([\s\S]*?)',\s*\n\s*width:\s*(\d+),\s*\n\s*height:\s*(\d+)/g)) {
    out.push({ id: m[1]!, title: m[2]!.trim(), width: Number(m[3]), height: Number(m[4]) });
  }
  return out;
}

async function fetchEsoCredit(id: string): Promise<string> {
  try {
    const r = await timedFetch(`https://www.eso.org/public/images/${id}/`, META_TIMEOUT_MS);
    if (!r.ok) return 'ESO';
    const html = await r.text();
    const c = stripHtml(html.match(/class="credit"[^>]*>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? '').slice(0, 60);
    if (!c) return 'ESO';
    // ~6/16 credits already say exactly "ESO" — appending the org again renders "ESO · ESO".
    return /(?:^|[\s/])ESO(?:$|[\s/])/.test(c) ? c : `${c} · ESO`;
  } catch {
    return 'ESO';
  }
}

async function buildEsoPool(): Promise<BuildResult> {
  // The listing pages are static, so rotate which page of each category a build uses
  // (day-cycle, capped by that category's depth) — otherwise every rebuild rediscovers
  // the same 300 entries.
  const day = Math.floor(Date.now() / DAY_MS);
  const listings = await runPool(
    Object.entries(ESO_CATEGORIES).map(([cat, depth]) => async () => {
      const page = 1 + (day % Math.min(depth, 10));
      const r = await timedFetch(
        `https://www.eso.org/public/images/archive/category/${cat}/list/${page}/`,
        META_TIMEOUT_MS,
        { headers: { 'user-agent': 'Mozilla/5.0 (compatible; HomeDashboard/0.1; personal home display)' } },
      );
      if (!r.ok) throw new Error(`eso ${cat} p${page} HTTP ${r.status}`);
      return parseEsoListing(await r.text());
    }),
    6,
    250,
    60_000,
  );
  const seen = new Set<string>();
  let entries: EsoEntry[] = [];
  for (const res of listings) {
    if (res.status !== 'fulfilled') continue;
    for (const e of res.value) {
      // editorial ids only (skip odd uploads like m_16_tunnel_centre); landscape & big enough
      if (!/^(eso|ann|potw)\d{4}[a-z]$/i.test(e.id) || e.width < 1920 || e.width <= e.height) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
    }
  }
  if (!entries.length) throw new Error('eso listing empty');
  // HEAD-screen the masters first (they reach 155 MB / 64 MB — live-probed): keep only files
  // within budget, so a selected ESO item never fails download for the whole hour.
  // Hard deadline: slow-but-alive cdn.eso.org must not stretch a background build forever.
  const shuffled = seededShuffle(entries, 0x50534f).slice(0, Math.ceil(ESO_CAP * 1.6));
  const sizes = await runPool(
    shuffled.map((e) => async () => {
      const h = await timedFetch(`https://cdn.eso.org/images/large/${e.id}.jpg`, HEAD_TIMEOUT_MS, { method: 'HEAD' });
      if (!h.ok) throw new Error(`eso head ${e.id} HTTP ${h.status}`);
      return Number(h.headers.get('content-length') ?? 0);
    }),
    5,
    120,
    90_000,
  );
  const kept = shuffled.filter((_, i) => sizes[i]!.status === 'fulfilled' && sizes[i]!.value > 0 && sizes[i]!.value <= ESO_MAX_BYTES);
  if (!kept.length) throw new Error('no ESO images within size budget');
  const screened = kept.slice(0, ESO_CAP);
  // Enrich with real per-image credits (CC BY requires them; "ESO/S. Brunier" ≠ "ESO").
  const credits = await runPool(
    screened.map((e) => () => fetchEsoCredit(e.id)),
    4,
    200,
    90_000,
  );
  const items: BgItem[] = screened.map((e, k) => {
    const id = `eso-${e.id}`;
    const url = `https://cdn.eso.org/images/large/${e.id}.jpg`;
    return {
      id,
      title: e.title.slice(0, 90),
      credit: credits[k]!.status === 'fulfilled' ? credits[k]!.value : 'ESO',
      date: '',
      url,
      urls: [url],
      query: 'eso',
      src: 'eso' as BgSource,
      headCheck: true, // defense in depth: abort before pulling an oversized master anyway
      maxBytes: ESO_MAX_BYTES,
    };
  });
  const anyFail = [...listings, ...sizes, ...credits].some((r) => r.status === 'rejected');
  return { items, partial: anyFail };
}

const esoPool = (dir: string): Promise<BgItem[]> => refreshManifest(dir, 'eso.json', ESO_TTL_MS, ESO_CAP, buildEsoPool);

// ---------- selection ----------

export interface BgCurrent {
  key: number; // wall-clock hour index (bing-daily: YYYYMMDD)
  total: number;
  item: BgItem;
  source: BgSource;
}

/** Picks mix / nasa-rotate / bing-daily / bing-rotate for a mode/market pair. */
export async function pickBackground(root: string, mode: string, market: string, now = Date.now()): Promise<BgCurrent> {
  const dir = backgroundsDir(root);

  if (mode === 'bing-daily') {
    const live = await bingLivePool(dir, market);
    // Defensive max-by-date: the live manifest is merge:false so items[0] is the feed's
    // newest, but a hand-edited/corrupted file must never serve yesterday's art silently.
    const item = live.reduce((m, i) => (i.date > m.date ? i : m), live[0]!);
    return { key: Number(item.date.replaceAll('-', '')), total: 1, item, source: 'bing' };
  }

  const requests: Array<Promise<BgItem[]>> = [];
  if (mode === 'nasa-rotate') requests.push(nasaPool(dir));
  else if (mode === 'bing-rotate') requests.push(bingLivePool(dir, market), bingArchivePool(dir, market));
  else
    requests.push(
      nasaPool(dir),
      bingLivePool(dir, market),
      bingArchivePool(dir, market),
      wallhavenPool(dir),
      commonsPool(dir),
      esoPool(dir),
    );

  const settled = await Promise.allSettled(requests);
  const bad = readBad(dir);
  const items: BgItem[] = [];
  const ids = new Set<string>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue; // a library that fails just drops out; offline keeps stale manifests
    for (const it of s.value) {
      if (!bad.has(it.id) && !ids.has(it.id)) {
        ids.add(it.id);
        items.push(it);
      }
    }
  }
  if (!items.length) throw new Error('no background sources available');

  const key = Math.floor(now / HOUR_MS);
  const tag = `${mode}|${market}`;
  const entries = readSeen(dir);
  const item = selectItem(items, key, entries, tag);
  recordPick(dir, key, item.id, entries, tag);
  return { key, total: items.length, item, source: item.src ?? (item.query === 'bing' ? 'bing' : 'nasa') };
}

// ---------- local file cache (LRU) ----------

/** Content type by magic bytes — every source is JPEG by build-time filter, but never trust that. */
export function sniffImageType(file: string): string {
  try {
    const b = Buffer.alloc(8);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  } catch {
    /* fall through */
  }
  return 'image/jpeg';
}

/** True if `buf` starts with JPEG or PNG magic bytes, not an error page saved by mistake. */
function isImage(buf: Buffer): boolean {
  const jpeg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  return jpeg || png;
}

/**
 * Raised when no candidate URL yielded bytes. `dead` distinguishes WHY: true only if some
 * candidate answered with 404/410 (the asset itself is gone upstream), false for network/
 * timeout/5xx/fs errors — blacklisting on those would poison hundreds of healthy ids during
 * any router outage (a picked image is deliberately recent-window-unseen, i.e. uncached).
 */
class BackgroundDownloadError extends Error {
  constructor(message: string, readonly dead: boolean) {
    super(message);
  }
}

export function isDeadAssetError(err: unknown): boolean {
  return err instanceof BackgroundDownloadError && err.dead;
}

/** Path to a locally cached image for `item`; downloads on first request of that hour. */
export async function getBackgroundFile(root: string, item: BgItem): Promise<string> {
  const dir = backgroundsDir(root);
  const file = path.join(dir, `${item.id}.jpg`);
  const usable = () => fs.existsSync(file) && fs.statSync(file).size > 5_000;
  if (usable()) {
    try {
      const t = new Date();
      fs.utimesSync(file, t, t); // LRU touch — a read-only disk/AV lock must not 502 a cached image
    } catch {
      /* mtime is best-effort */
    }
    return file;
  }
  const maxBytes = Math.min(item.maxBytes ?? MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES);
  let gone = false;
  for (const u of item.urls?.length ? item.urls : [item.url]) {
    try {
      if (item.headCheck) {
        // ESO masters reach 155 MB: consult Content-Length before buffering anything.
        const h = await timedFetch(u, HEAD_TIMEOUT_MS, { method: 'HEAD' });
        if (h.status === 404 || h.status === 410) {
          gone = true;
          continue;
        }
        const len = Number(h.headers.get('content-length') ?? 0);
        if (!h.ok || len > maxBytes) continue;
      }
      const r = await timedFetch(u, IMAGE_TIMEOUT_MS);
      if (r.status === 404 || r.status === 410) {
        gone = true;
        continue;
      }
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 5_000 || buf.length > maxBytes || !isImage(buf)) continue;
      const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`; // atomic land: no stubs on partial failure
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      cleanupLru(dir, file);
      return file;
    } catch {
      /* next candidate */
    }
  }
  if (usable()) return file; // network dead: serve the stale bytes we have
  throw new BackgroundDownloadError(`background download failed for ${item.id}`, gone);
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
