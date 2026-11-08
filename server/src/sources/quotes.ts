/**
 * Stock/index quotes from Yahoo Finance's v8 chart endpoint (keyless; the quote
 * endpoint now demands crumb+cookie, the chart one does not). Per-symbol disk
 * cache so a rate-limit blip or offline spell keeps the tape showing the last
 * good price with stale=true instead of going blank.
 */

export interface Quote {
  code: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  currency: string;
  updatedAt: number; // when this symbol last fetched successfully
  stale: boolean;
  error?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HomeDashboard/0.1';
const FRESH_MS = 60_000; // reuse cached quote for 1 min (market data; tape doesn't need more)

interface Cached extends Omit<Quote, 'stale'> {}

interface YahooChart {
  chart?: {
    error?: { description?: string };
    result?: {
      meta?: Record<string, number | string | undefined>;
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

const mem = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached>>();

function normCode(code: string): string {
  return code.trim().toUpperCase();
}

async function fetchYahoo(code: string): Promise<Cached> {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?range=5d&interval=1d`;
  const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`yahoo ${code} -> HTTP ${r.status}`);
  const data = (await r.json()) as YahooChart; // boundary JSON; fields guarded with ?. + Number.isFinite
  const err = data.chart?.error;
  if (err) throw new Error(`yahoo ${code}: ${err.description ?? 'chart error'}`);
  const result = data.chart?.result?.[0];
  const m = result?.meta;
  const price = Number(m?.regularMarketPrice);
  // chartPreviousClose is the close before the fetched window; recompute the true
  // previous close from daily closes so multi-day breaks (weekend/holiday) still work.
  let prev = Number(m?.chartPreviousClose);
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => c != null && Number.isFinite(c));
  if (closes.length >= 2) prev = closes[closes.length - 2];
  else if (m?.previousClose != null) prev = Number(m.previousClose);
  if (!Number.isFinite(price) || !Number.isFinite(prev)) throw new Error(`yahoo ${code}: no numeric price`);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    code,
    price: round(price),
    prevClose: round(prev),
    change: round(price - prev),
    changePct: prev !== 0 ? round(((price - prev) / prev) * 100) : 0,
    currency: String(m?.currency ?? 'USD'),
    updatedAt: Date.now(),
  };
}

async function getQuote(codeRaw: string): Promise<Quote> {
  const code = normCode(codeRaw);
  const hit = mem.get(code);
  if (hit && Date.now() - hit.updatedAt < FRESH_MS) return { ...hit, stale: false };
  let p = inflight.get(code);
  if (!p) {
    p = fetchYahoo(code)
      .then((c) => {
        mem.set(code, c);
        return c;
      })
      .finally(() => inflight.delete(code));
    inflight.set(code, p);
  }
  try {
    const c = await p;
    return { ...c, stale: false };
  } catch (err) {
    if (hit) return { ...hit, stale: true }; // keep last good print
    return {
      code,
      price: NaN,
      prevClose: NaN,
      change: NaN,
      changePct: NaN,
      currency: '',
      updatedAt: 0,
      stale: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getQuotes(codes: string[]): Promise<Quote[]> {
  return Promise.all(codes.map(getQuote));
}
