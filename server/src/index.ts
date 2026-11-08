import express, { type Request } from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { getHolidays } from './sources/holidays.js';
import { getFedEvents } from './sources/fed.js';
import { getCurrent, getBingCurrent, getMixedCurrent, getBackgroundFile } from './sources/background.js';
import { getWeather } from './sources/weather.js';
import { getQuotes } from './sources/quotes.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HD_ROOT ? path.resolve(process.env.HD_ROOT) : path.resolve(dirname, '../..');
const PORT = Number(process.env.PORT ?? 8787);
const startedAt = Date.now();

const app = express();
app.disable('x-powered-by');

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

/** Picks mix / nasa-rotate / bing-daily / bing-rotate (+market) from the query. */
const pickBackground = (req: Request) => {
  const mode = String(req.query.mode ?? 'nasa-rotate');
  const market = String(req.query.market || 'en-US');
  const at = Number(req.query.at) || undefined; // preview a specific epoch-ms hour (testing)
  if (mode === 'mix') return getMixedCurrent(ROOT, market, at);
  return mode.startsWith('bing') ? getBingCurrent(ROOT, mode, market, at) : getCurrent(ROOT, at);
};

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
    res.setHeader('cache-control', 'public, max-age=3600');
    res.type('image/jpeg').sendFile(file, (err) => {
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

const dist = path.join(ROOT, 'web', 'dist');
app.use(express.static(dist));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(dist, 'index.html'), (err) => next(err));
  } else {
    next();
  }
});

app.listen(PORT, () => {
  console.log(`[homedashboard] http://localhost:${PORT}`);
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  for (const ip of lan) console.log(`[homedashboard] LAN: http://${ip}:${PORT}`);
});
