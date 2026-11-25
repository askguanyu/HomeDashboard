import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type DashboardConfig } from './config.js';
import { getHolidays } from './sources/holidays.js';
import { getFedEvents, startFedMaintenance } from './sources/fed.js';
import { getCurrent, getBingCurrent, getMixedCurrent, getBackgroundFile } from './sources/background.js';
import { getWeather } from './sources/weather.js';
import { getQuotes } from './sources/quotes.js';
import { getSystemDebug, getSystemLoad, startSystemSampler } from './sources/system.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HD_ROOT ? path.resolve(process.env.HD_ROOT) : path.resolve(dirname, '../..');
const PORT = Number(process.env.PORT ?? 8787);
const startedAt = Date.now();

const app = express();
app.disable('x-powered-by');

/** Best-effort client IP: honor reverse proxy, normalize IPv4-mapped IPv6. */
const clientIp = (req: Request): string => {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]?.trim();
  const raw = first || req.socket.remoteAddress || req.ip || '?';
  return raw.replace(/^::ffff:/, '');
};

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
  });
});

app.get('/api/config', (_req, res) => {
  try {
    res.json(loadConfig(ROOT));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/holidays', (req, res) => {
  const year = Number(req.query.year ?? new Date().getFullYear());
  const country = String(req.query.country ?? 'US');
  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    res.status(400).json({ error: 'bad year' });
    return;
  }
  if (!/^[A-Z]{2}$/.test(country)) {
    res.status(400).json({ error: 'bad country' });
    return;
  }
  try {
    res.json(getHolidays(country, year));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/fed', async (req, res) => {
  const year = Number(req.query.year ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    res.status(400).json({ error: 'bad year' });
    return;
  }
  try {
    res.json(await getFedEvents(ROOT, year));
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Picks mix / nasa-rotate / bing-daily / bing-rotate (+market) for a mode/market pair. */
const pickFor = (mode: string, market: string, at?: number) => {
  if (mode === 'mix') return getMixedCurrent(ROOT, market, at);
  return mode.startsWith('bing') ? getBingCurrent(ROOT, mode, market, at) : getCurrent(ROOT, at);
};

/** Same, driven by the request query. */
const pickBackground = (req: Request) =>
  pickFor(String(req.query.mode ?? 'nasa-rotate'), String(req.query.market || 'en-US'), Number(req.query.at) || undefined);

app.get('/api/background', async (req, res) => {
  try {
    const { key, total, item, source } = await pickBackground(req);
    res.json({
      key,
      total,
      source,
      item: { id: item.id, title: item.title, credit: item.credit, date: item.date },
      image: '/api/background/image',
    });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/background/image', async (req, res) => {
  try {
    const { item } = await pickBackground(req);
    const file = await getBackgroundFile(ROOT, item);
    // The hour key in `k=` makes every rotation a distinct URL, so even a browser that
    // answers a repeat URL from its cache without revalidating still gets new art. Within
    // one hour the URL repeats (reload), and the wallpaper id is the validator there:
    // getBackgroundFile touches mtime on every hit (LRU), so stat-derived validators churn.
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    res.set('etag', `"bg-${item.id}"`);
    res.type('image/jpeg').sendFile(file, { etag: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) res.status(502).json({ error: 'background file unreadable' });
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/weather', async (req, res) => {
  try {
    const cfg = loadConfig(ROOT);
    const units = req.query.units === 'metric' ? 'metric' : 'imperial';
    const days = Math.max(1, Math.min(10, Number(req.query.days) || 5));
    res.json(await getWeather(ROOT, cfg.location, units, days, cfg.timezone));
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/quotes', async (req, res) => {
  const codes = String(req.query.symbols ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!codes.length) {
    res.status(400).json({ error: 'symbols=a,b,c required' });
    return;
  }
  try {
    res.json({ updatedAt: Date.now(), quotes: await getQuotes(codes) });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/system', (_req, res) => {
  res.json(getSystemLoad());
});

/** GPU readings and the sampler's own health, for debugging the load widget over curl. */
app.get('/api/system/debug', (_req, res) => {
  res.json({ ...getSystemLoad(), ...getSystemDebug(), cores: os.cpus().length, uptimeSec: Math.round(os.uptime()) });
});

const dist = path.join(ROOT, 'web', 'dist');

/**
 * Wallpaper URL the browser can start downloading alongside the document, before React
 * resolves /api/config + /api/background. Must build byte-identical URLs to
 * web/src/Background.tsx, or the preload is just a second download.
 */
async function preloadImageUrl(cfg: DashboardConfig): Promise<string | null> {
  const theme = cfg.theme;
  if (theme?.backgroundImage) return theme.backgroundImage;
  const mode = theme?.background ?? 'starry';
  if (!(mode === 'mix' || mode === 'nasa-rotate' || mode.startsWith('bing'))) return null;
  const market = theme?.backgroundMarket || 'en-US';
  const { key } = await pickFor(mode, market); // the client repeats this exact `k=` on first paint
  return `/api/background/image?k=${key}&mode=${encodeURIComponent(mode)}&market=${encodeURIComponent(market)}`;
}

/** Built index.html plus a preload hint: CSS-background images get no scanner priority. */
async function sendShell(_req: Request, res: Response, next: NextFunction): Promise<void> {
  let html: string;
  try {
    html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  } catch (err) {
    return next(err);
  }
  let preload = '';
  try {
    const url = await preloadImageUrl(loadConfig(ROOT));
    if (url) {
      const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      preload = `\n    <link rel="preload" as="image" fetchpriority="high" href="${href}" />`;
    }
  } catch {
    // Bad or missing config, or the wallpaper pool is unreadable: still serve the shell.
  }
  res.set('cache-control', 'no-cache'); // the shell must revalidate so rebuilt bundles are picked up
  res.type('html').send(html.replace('</head>', `${preload}\n  </head>`));
}

app.use((req, res, next) => {
  // Log only document loads (navigation / refresh), not assets or /api polls.
  // Browsers send `Accept: text/html,...` on navigation; js/css/images don't.
  const accept = req.headers.accept ?? '';
  if (req.method === 'GET' && accept.includes('text/html') && !req.path.startsWith('/api/')) {
    console.log(`[client] ${new Date().toLocaleString()} page load from ${clientIp(req)}${req.path === '/' ? '' : ' ' + req.path}  (UA: ${req.headers['user-agent'] ?? '?'})`);
  }
  next();
});

app.get('/', sendShell);
app.use(express.static(dist, { index: false })); // '/' belongs to sendShell above
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    sendShell(req, res, next);
  } else {
    next();
  }
});

app.listen(PORT, () => {
  console.log(`[homedashboard] http://localhost:${PORT}`);
  startFedMaintenance(ROOT); // weekly background scrape; page loads read disk cache only
  startSystemSampler(); // CPU delta window + nvidia-smi poll, off the request path
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  for (const ip of lan) console.log(`[homedashboard] LAN: http://${ip}:${PORT}`);
});
