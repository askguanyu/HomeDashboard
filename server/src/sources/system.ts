/**
 * Server-machine load: CPU from os.cpus() counter deltas, GPU from nvidia-smi.
 *
 * Windows has no load average (os.loadavg() is always [0,0,0] there), so CPU
 * utilization comes from the cumulative per-core times each core reports:
 * 100 * (1 - dIdle / dTotal) over the window since the previous snapshot. Those
 * counters are monotonic since boot, so the very first call has no window to
 * diff against and reports null until one sample interval has elapsed.
 *
 * A background sampler owns both readings so an /api/system poll never blocks:
 * spawning nvidia-smi costs ~0.2-0.5 s on Windows, which is longer than the
 * widget's whole refresh. The last good GPU read is kept (with stale=true past
 * STALE_MS) so a driver hiccup dims the widget instead of blanking it, matching
 * how quotes.ts and the weather cache behave.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';

export interface SystemPayload {
  /** busy % of all cores averaged, null before the first sample window closes */
  cpuPct: number | null;
  /** busy % of the busiest GPU, null when this box has no readable NVIDIA GPU */
  gpuPct: number | null;
  /** the busier of the two: one number for "is this machine working" */
  combinedPct: number | null;
  gpuName: string | null;
  /** false once nvidia-smi proved unavailable; the widget then drops the GPU row */
  gpuSupported: boolean;
  /** last successful sample of the sources that are expected to answer */
  sampledAt: number | null;
  /** older than STALE_MS, or the sampler never produced a reading */
  stale: boolean;
  /** combined % per sample, oldest first, newest last; ~HISTORY_LEN*SAMPLE_MS of trend */
  history: number[];
}

const SAMPLE_MS = 5_000; // widget cadence; also the CPU delta window
const STALE_MS = 30_000; // one missed poll chain still looks live, two do not
const GPU_TIMEOUT_MS = 3_000; // a hung nvidia-smi must not stall the sampler
const GPU_GIVEUP_AFTER = 3; // consecutive failures that mean "no NVIDIA here", not "busy"
const HISTORY_LEN = 120; // 120 x 5 s = 10 minutes of trend behind the sparkline

const GPU_QUERY = ['--query-gpu=utilization.gpu,memory.used,memory.total,name', '--format=csv,noheader,nounits'];

interface GpuRow {
  util: number;
  name: string;
}

let cpuPct: number | null = null;
let gpuPct: number | null = null;
let gpuName: string | null = null;
let gpuSupported = true;
let prevCpu: { idle: number; total: number } | null = null;
let gpuFailures = 0;
let gpuError: string | null = null;
/* Per-source timestamps: one shared "last sample" would let a live CPU counter mask a
   GPU that stopped answering, and the widget would print a stale percentage as if live. */
let cpuAt: number | null = null;
let gpuAt: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const history: number[] = [];

/** Sum the cumulative jiffies every core reports since boot. */
function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function sampleCpu(): void {
  const now = cpuTotals();
  if (prevCpu) {
    const dTotal = now.total - prevCpu.total;
    const dIdle = now.idle - prevCpu.idle;
    // Counter reset (sleep/hibernate, or a counter wrap) reads as a non-positive
    // window: keep the previous number rather than publishing 0% or NaN.
    if (dTotal > 0) cpuPct = clampPct(100 * (1 - dIdle / dTotal));
  }
  prevCpu = now;
}

function isStale(at: number | null): boolean {
  return at == null || Date.now() - at > STALE_MS;
}

function latest(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function clampPct(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** Parse nvidia-smi's CSV: one "util, memUsed, memTotal, name" row per GPU. */
export function parseGpuCsv(out: string): GpuRow[] {
  const rows: GpuRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 2) continue;
    const util = Number(f[0]);
    if (!Number.isFinite(util)) continue;
    rows.push({ util: clampPct(util), name: f[3] || f[2] || 'GPU' });
  }
  return rows;
}

function readGpu(): Promise<GpuRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'nvidia-smi',
      GPU_QUERY,
      {
        timeout: GPU_TIMEOUT_MS,
        windowsHide: true, // the display PC must never flash a console window
        encoding: 'utf8',
        maxBuffer: 1 << 16,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          resolve(parseGpuCsv(stdout));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
  });
}

async function sampleGpu(): Promise<void> {
  if (!gpuSupported) return;
  try {
    const rows = await readGpu();
    if (!rows.length) throw new Error('no gpu rows');
    const busiest = rows.reduce((a, b) => (b.util > a.util ? b : a));
    gpuPct = busiest.util;
    gpuName = busiest.name;
    gpuFailures = 0;
    gpuError = null;
    gpuAt = Date.now();
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'nvidia-smi not found' : String((err as Error)?.message ?? err);
    gpuError = msg;
    gpuFailures += 1;
    if (gpuFailures >= GPU_GIVEUP_AFTER) gpuSupported = false; // stop paying the spawn cost forever
  }
}

function combinedNow(): number | null {
  const parts = [cpuPct, gpuSupported ? gpuPct : null].filter((n): n is number => n != null);
  return parts.length ? Math.max(...parts) : null;
}

function tick(): void {
  // Trend records what the widget showed over the interval that just closed, so the
  // newest point lines up with the number on screen rather than leading it by one poll.
  const last = combinedNow();
  if (last != null) {
    history.push(last);
    if (history.length > HISTORY_LEN) history.shift();
  }
  sampleCpu();
  if (cpuPct != null) cpuAt = Date.now();
  void sampleGpu();
}

export function startSystemSampler(): void {
  if (timer) return;
  tick(); // baseline snapshot + first GPU read
  timer = setInterval(tick, SAMPLE_MS);
  timer.unref?.(); // never hold the process open on its own
}

export function getSystemLoad(): SystemPayload {
  return {
    cpuPct,
    gpuPct: gpuSupported ? gpuPct : null,
    combinedPct: combinedNow(),
    gpuName: gpuSupported ? gpuName : null,
    gpuSupported,
    sampledAt: latest(cpuAt, gpuAt),
    stale: isStale(cpuAt) || (gpuSupported && isStale(gpuAt)),
    history: history.slice(),
  };
}

/** Only for the debug endpoint and tests: why the GPU row went quiet. */
export function getSystemDebug(): { gpuError: string | null; gpuFailures: number; sampleMs: number; cpuAgeMs: number | null; gpuAgeMs: number | null } {
  const age = (t: number | null) => (t == null ? null : Date.now() - t);
  return { gpuError, gpuFailures, sampleMs: SAMPLE_MS, cpuAgeMs: age(cpuAt), gpuAgeMs: age(gpuAt) };
}
