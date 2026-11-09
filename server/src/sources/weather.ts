import fs from 'node:fs';
import path from 'node:path';

/**
 * Weather: Open-Meteo (primary, one call gives current + daily + sunrise/sunset,
 * free no key) with NWS gridpoint forecast as a US fallback. Disk cache; when a
 * refresh fails the last good payload is served with stale=true.
 * Zip codes resolve through api.zippopotam.us (also keyless), cached next to this file.
 */

export interface WeatherDay {
  date: string; // YYYY-MM-DD (location local)
  code: number; // WMO
  text: string; // zh
  hi: number;
  lo: number;
  pop: number | null; // precip probability %
}

export interface WeatherPayload {
  source: 'open-meteo' | 'nws';
  location: { name: string; lat: number; lon: number };
  units: 'imperial' | 'metric';
  current: {
    temp: number;
    feels: number;
    code: number;
    text: string;
    humidity: number | null;
    windSpeed: number | null;
    windDeg: number | null;
    pressure: number | null;
    visibilityMi: number | null;
    sunrise: string; // HH:mm local
    sunset: string;
  };
  daily: WeatherDay[];
  updatedAt: number;
  stale: boolean;
}

export interface LocationCfg {
  zip?: string;
  name?: string;
  lat?: number;
  lon?: number;
}

const UA = 'HomeDashboard/0.1 (personal home display; local aggregation server)';
const TTL_MS = 10 * 60_000;

const WMO_ZH: Record<number, string> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '阵雪',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '雷暴伴冰雹',
};

export function wmoText(code: number): string {
  return WMO_ZH[code] ?? `天气(${code})`;
}

/** NWS shortForecast (English) → zh; longest phrases first so "mostly sunny" beats "sunny". */
const NWS_TERMS: [RegExp, string][] = [
  [/thunderstorms?( and| w(?:ith)? )?hail/i, '雷暴伴冰雹'],
  [/showers? and thunderstorms?|thunderstorms?/i, '雷阵雨'],
  [/freezing (?:rain|drizzle)/i, '冻雨'],
  [/sleet|wintry mix/i, '雨夹雪'],
  [/snow(?: showers)?/i, '雪'],
  [/\bice\b/i, '冰'],
  [/fog|mist/i, '雾'],
  [/rain/i, '雨'],
  [/drizzle/i, '毛毛雨'],
  [/showers?/i, '阵雨'],
  [/windy/i, '大风'],
  [/haze|smoke/i, '霾'],
  [/mostly sunny|mostly clear/i, '晴间多云'],
  [/partly sunny|partly cloudy/i, '多云'],
  [/mostly cloudy/i, '多云转阴'],
  [/scattered/i, '局部'],
  [/isolated/i, '零星'],
  [/sunny|clear/i, '晴'],
  [/cloudy|overcast/i, '阴'],
];

function nwsText(short: string): string {
  let out = short;
  for (const [re, zh] of NWS_TERMS) out = out.replace(re, zh);
  // strip leftover English scaffolding: "Chance Rain" -> "雨", percentages kept
  out = out
    .replace(/\b(?:chance|likelihood|prob(?:ability)?)\b\s*\d{0,3}%?/gi, '')
    .replace(/\b\d{1,2}\s?(?:to\s?\d{1,2}\s?)?%?\s*(?:chance|of)\b/gi, '')
    .replace(/[A-Za-z][A-Za-z' -]*/g, '')
    .replace(/\s+/g, '')
    .trim();
  return out || short;
}

// ---------- coordinate resolution ----------

interface Coords {
  lat: number;
  lon: number;
  name: string;
}

function geoCacheFile(root: string): string {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return path.join(root, 'data', 'geo.json');
}

async function resolveCoords(root: string, loc: LocationCfg | undefined): Promise<Coords> {
  if (loc?.lat != null && loc?.lon != null) {
    return { lat: +loc.lat, lon: +loc.lon, name: loc.name ?? loc.zip ?? '未知地点' };
  }
  const cache = new Map<string, Coords>();
  try {
    const j = JSON.parse(fs.readFileSync(geoCacheFile(root), 'utf8')) as Record<string, Coords>;
    for (const [k, v] of Object.entries(j)) cache.set(k, v);
  } catch {
    /* first run */
  }
  const key = loc?.zip ? `zip:${loc.zip}` : `name:${loc?.name ?? ''}`;
  if (loc?.zip && cache.has(key)) return cache.get(key)!;
  if (loc?.zip && /^\d{5}$/.test(loc.zip)) {
    const r = await fetch(`https://api.zippopotam.us/us/${loc.zip}`, { headers: { 'user-agent': UA } });
    if (r.ok) {
      const j = (await r.json()) as { places?: { latitude: string; longitude: string; 'place name'?: string }[] };
      const p = j.places?.[0];
      if (p) {
        const c = { lat: +p.latitude, lon: +p.longitude, name: loc.name ?? p['place name'] ?? loc.zip };
        cache.set(key, c);
        fs.writeFileSync(geoCacheFile(root), JSON.stringify(Object.fromEntries(cache)));
        return c;
      }
    }
  }
  if (loc?.name) {
    const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc.name)}&count=1&language=en&format=json`;
    const r = await fetch(u, { headers: { 'user-agent': UA } });
    if (r.ok) {
      const j = (await r.json()) as { results?: { latitude: number; longitude: number; name: string }[] };
      const g = j.results?.[0];
      if (g) {
        const c = { lat: g.latitude, lon: g.longitude, name: loc.name ?? g.name };
        cache.set(key, c);
        fs.writeFileSync(geoCacheFile(root), JSON.stringify(Object.fromEntries(cache)));
        return c;
      }
    }
  }
  throw new Error(`无法解析位置 ${JSON.stringify(loc ?? {})}（建议 config 里直接写 lat/lon）`);
}

// ---------- providers ----------

async function fromOpenMeteo(c: Coords, units: 'imperial' | 'metric', days: number, timezone: string): Promise<Omit<WeatherPayload, 'updatedAt' | 'stale'>> {
  const u =
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,pressure_msl,visibility,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `&timezone=${encodeURIComponent(timezone)}&forecast_days=${Math.min(days + 1, 16)}` +
    (units === 'metric' ? '&temperature_unit=celsius&wind_speed_unit=kmh' : '&temperature_unit=fahrenheit&wind_speed_unit=mph');
  const r = await fetch(u, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`open-meteo -> HTTP ${r.status}`);
  const j = (await r.json()) as {
    current: Record<string, number>;
    daily: Record<string, (string | number | null)[]>;
  };
  const cur = j.current;
  const hhmm = (s: string | number | null | undefined) => (s != null ? String(s).slice(11, 16) : '--:--');
  const daily: WeatherDay[] = j.daily.time.map((date, i) => ({
    date: String(date),
    code: Number(j.daily.weather_code[i]),
    text: wmoText(Number(j.daily.weather_code[i])),
    hi: Math.round(Number(j.daily.temperature_2m_max[i])),
    lo: Math.round(Number(j.daily.temperature_2m_min[i])),
    pop: j.daily.precipitation_probability_max?.[i] == null ? null : Number(j.daily.precipitation_probability_max[i]),
  }));
  return {
    source: 'open-meteo',
    location: c,
    units,
    current: {
      temp: Math.round(cur.temperature_2m),
      feels: Math.round(cur.apparent_temperature),
      code: Number(cur.weather_code),
      text: wmoText(Number(cur.weather_code)),
      humidity: cur.relative_humidity_2m ?? null,
      windSpeed: cur.wind_speed_10m ?? null,
      windDeg: cur.wind_direction_10m ?? null,
      pressure: cur.pressure_msl ?? null,
      visibilityMi: cur.visibility == null ? null : Math.round((cur.visibility / 1609.34) * 10) / 10,
      sunrise: hhmm(j.daily.sunrise[0]),
      sunset: hhmm(j.daily.sunset[0]),
    },
    daily: daily.slice(0, days + 1), // [0] = today (feeds the current block); rest = forecast columns
  };
}

async function fromNws(c: Coords, units: 'imperial' | 'metric', days: number): Promise<Omit<WeatherPayload, 'updatedAt' | 'stale'>> {
  const hdr = { 'user-agent': UA, accept: 'application/geo+json' };
  const pr = await fetch(`https://api.weather.gov/points/${c.lat},${c.lon}`, { headers: hdr });
  if (!pr.ok) throw new Error(`nws points -> HTTP ${pr.status}`);
  const pts = (await pr.json()) as { properties: { forecast: string; forecastHourly: string; relativeLocation: { features?: { properties?: { city?: string; state?: string } }[] } } };
  const fr = await fetch(pts.properties.forecast, { headers: hdr });
  if (!fr.ok) throw new Error(`nws forecast -> HTTP ${fr.status}`);
  const fc = (await fr.json()) as { properties: { periods: NwsPeriod[] } };
  const periods = fc.properties.periods ?? [];
  if (!periods.length) throw new Error('nws forecast: no periods');
  // 3-hourly periods → group into days by startTime
  const byDay = new Map<string, NwsPeriod[]>();
  for (const p of periods) {
    const d = p.startTime.slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(p);
  }
  const dayEntries = [...byDay.entries()].slice(0, days + 1);
  const conv = (t: number, unit: string): number => {
    const c = unit.toUpperCase() === 'F' ? ((t - 32) * 5) / 9 : t; // NWS sends local unit
    return Math.round(units === 'imperial' ? (c * 9) / 5 + 32 : c);
  };
  const daily: WeatherDay[] = dayEntries.map(([date, ps]) => ({
    date,
    code: nwsToCode(ps.map((p) => p.shortForecast).join(' ')),
    text: nwsText(ps[0].shortForecast),
    hi: Math.max(...ps.map((p) => conv(p.temperature, p.temperatureUnit))),
    lo: Math.min(...ps.map((p) => conv(p.temperature, p.temperatureUnit))),
    pop: maxPop(ps),
  }));
  const today = dayEntries[0][1];
  const now = today[0];
  return {
    source: 'nws',
    location: { ...c, name: pts.properties.relativeLocation?.features?.[0]?.properties?.city ?? c.name },
    units,
    current: {
      temp: conv(now.temperature, now.temperatureUnit),
      feels: conv(now.temperature, now.temperatureUnit), // NWS forecast lacks feels-like; acceptable in fallback
      code: nwsToCode(now.shortForecast),
      text: nwsText(now.shortForecast),
      humidity: null,
      windSpeed: parseWind(now.windSpeed),
      windDeg: windDeg(now.windDirection),
      pressure: null,
      visibilityMi: null,
      sunrise: '--:--',
      sunset: '--:--',
    },
    daily,
  };
}

interface NwsPeriod {
  startTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string; // 'F' | 'C'
  windSpeed: string; // "8 mph" or "6 to 10 mph"
  windDirection: string; // "NW"
  shortForecast: string;
  probabilityOfPrecipitation?: { value: number | null };
}

function parseWind(s: string): number | null {
  const m = s.match(/(\d+)(?:\s*-\s*(\d+))?\s*(?:mph|mi\/h)/i);
  if (!m) return null;
  return Math.round(m[2] ? (+m[1] + +m[2]) / 2 : +m[1]);
}

const COMPASS: Record<string, number> = { N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157, S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337 };

function windDeg(s: string): number | null {
  return COMPASS[s.trim().toUpperCase()] ?? null;
}

function maxPop(ps: NwsPeriod[]): number | null {
  const vals = ps.map((p) => p.probabilityOfPrecipitation?.value).filter((v): v is number => v != null);
  return vals.length ? Math.max(...vals) : null;
}

/** crude reverse map NWS text → WMO-ish code for icon selection on the client */
function nwsToCode(t: string): number {
  const s = t.toLowerCase();
  if (/hail|thunderstorm/.test(s)) return s.includes('hail') ? 96 : 95;
  if (/snow|flurr/.test(s)) return /shower/.test(s) ? 85 : 73;
  if (/sleet|wintry|ice/.test(s)) return 66;
  if (/rain|drizzle|shower|precipitation/.test(s)) return /shower/.test(s) ? 80 : 63;
  if (/fog|mist|smoke|haze/.test(s)) return 45;
  if (/mostly (cloudy|overcast)/.test(s)) return 3;
  if (/partly/.test(s)) return 2;
  if (/mostly (sunny|clear)|sunny|clear/.test(s)) return 1;
  if (/cloudy|overcast/.test(s)) return 3;
  return 0;
}

// ---------- cache ----------

function cacheFile(root: string): string {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return path.join(root, 'data', 'weather-cache.json');
}

interface CacheFile {
  entries: Record<string, WeatherPayload>;
}

/** Key covers everything that changes the payload: units, forecast days, timezone, coordinates. */
function cacheKey(units: string, days: number, timezone: string, c: Coords): string {
  return `${units}|${days}|${timezone}|${c.lat},${c.lon}`;
}

function readCacheFile(root: string): CacheFile {
  try {
    const f = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8')) as CacheFile;
    if (f && typeof f.entries === 'object' && f.entries) return f;
  } catch {
    /* none or old single-payload format */
  }
  return { entries: {} };
}

function readCache(root: string, key: string): WeatherPayload | null {
  const e = readCacheFile(root).entries[key];
  return e && e.current && Array.isArray(e.daily) ? e : null;
}

function writeCache(root: string, key: string, payload: WeatherPayload): void {
  const f = readCacheFile(root);
  f.entries[key] = payload;
  fs.writeFileSync(cacheFile(root), JSON.stringify(f));
}

let inflight: { key: string; p: Promise<WeatherPayload> } | null = null;

export async function getWeather(
  root: string,
  loc: LocationCfg | undefined,
  units: 'imperial' | 'metric',
  days: number,
  timezone: string,
): Promise<WeatherPayload> {
  const c = await resolveCoords(root, loc);
  const key = cacheKey(units, days, timezone, c);
  const cache = readCache(root, key);
  if (cache && Date.now() - cache.updatedAt < TTL_MS) return cache;
  if (inflight && inflight.key === key) return inflight.p; // concurrent same-key refreshes: dedupe
  const job = (async () => {
    let payload: Omit<WeatherPayload, 'updatedAt' | 'stale'> | null = null;
    let lastErr: unknown = null;
    try {
      payload = await fromOpenMeteo(c, units, days, timezone);
    } catch (err) {
      lastErr = err;
      try {
        payload = await fromNws(c, units, days);
      } catch (err2) {
        lastErr = err2;
      }
    }
    if (payload) {
      const fresh: WeatherPayload = { ...payload, updatedAt: Date.now(), stale: false };
      writeCache(root, key, fresh);
      return fresh;
    }
    if (cache) {
      console.warn('[weather] refresh failed, serving stale:', lastErr instanceof Error ? lastErr.message : lastErr);
      return { ...cache, stale: true };
    }
    throw lastErr instanceof Error ? lastErr : new Error('weather: all sources failed');
  })();
  inflight = { key, p: job };
  job
    .catch(() => {})
    .finally(() => {
      if (inflight && inflight.p === job) inflight = null;
    });
  return job;
}
