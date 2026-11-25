import { usePoll } from '../hooks';
import type { SystemPayload } from '../api';
import type { WidgetProps } from './types';

/**
 * Load tone is not market direction: green/amber/red here mean "how hard the box is
 * working", so they deliberately do NOT reuse the --up/--down quote palette (which also
 * flips for red-up markets). Colors live in theme.css under [data-tone].
 */
function tone(pct: number | null): 'idle' | 'warm' | 'hot' {
  if (pct == null) return 'idle';
  if (pct >= 85) return 'hot';
  if (pct >= 60) return 'warm';
  return 'idle';
}

function pctLabel(pct: number | null): string {
  return pct == null ? '—' : `${pct}%`;
}

/**
 * 10-minute trend. Stretched to the cell with preserveAspectRatio="none" (so the
 * geometry scales but the stroke would), which is what vector-effect cancels —
 * Chrome 64+, above the pinned Chrome 72 floor.
 */
/**
 * Sparkline ceiling. A fixed 0-100 axis flattens an idle box (1-11% occupies 10% of the
 * box, unreadable from across a room), so the axis snaps up to the next 20% step above the
 * window's peak with a 20% floor. It is a shape indicator, not a measured chart: the peak
 * is printed next to it, so the rescaled axis hides nothing.
 */
function sparkCeil(peak: number): number {
  return Math.max(20, Math.ceil(peak / 20) * 20);
}

function Sparkline({ history }: { history: number[] }) {
  const n = history.length;
  if (n < 2) return <div className="sys-trend-note">趋势积累中…</div>;
  const ceil = sparkCeil(Math.max(...history));
  const pts = history.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(24 - (Math.max(0, Math.min(ceil, v)) / ceil) * 24).toFixed(2)}`);
  return (
    <svg className="sys-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polygon className="sys-spark-fill" points={`0,24 ${pts.join(' ')} 100,24`} />
      <polyline className="sys-spark-line" vectorEffect="non-scaling-stroke" points={pts.join(' ')} />
    </svg>
  );
}

function LoadRow({ name, pct }: { name: string; pct: number | null }) {
  return (
    <div className="sys-row">
      <span className="sys-name">{name}</span>
      <span className="sys-bar">
        {/* Chrome 72 has no aspect-ratio: the bar is a fixed-height box with an inner fill. */}
        <i data-tone={tone(pct)} style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="sys-val" data-tone={tone(pct)}>
        {pctLabel(pct)}
      </span>
    </div>
  );
}

export function SystemLoad({ widget }: WidgetProps) {
  const opts = widget.options ?? {};
  const everyMs = Math.max(2, Number(opts.refreshSec ?? 5)) * 1000;
  const { data, failing } = usePoll<SystemPayload>('/api/system', everyMs);

  if (!data) {
    return (
      <div className="placeholder">
        <div className="placeholder-title">负载</div>
        <div className="placeholder-note">{failing ? '暂时无法获取' : '采集中…'}</div>
      </div>
    );
  }

  const combined = data.combinedPct;
  const busy = tone(combined);
  const peak = data.history.length ? Math.max(...data.history) : combined;

  return (
    <div className="sys">
      {data.stale || failing ? <div className="stale-badge" role="status">缓存数据</div> : null}
      <div className="sys-now">
        <div className="sys-num" data-tone={busy}>
          {combined == null ? '—' : combined}
        </div>
        <div className="sys-side">
          <span className="sys-unit">%</span>
          <span className="sys-cap">综合负载</span>
        </div>
      </div>
      <div className="sys-rows">
        <LoadRow name="CPU" pct={data.cpuPct} />
        {data.gpuSupported ? <LoadRow name="GPU" pct={data.gpuPct} /> : <div className="sys-nogpu">无独立 GPU</div>}
      </div>
      <div className="sys-trend">
        <Sparkline history={data.history} />
        <div className="sys-trend-cap">
          <span>{`峰值 ${peak == null ? '—' : `${peak}%`}`}</span>
          <span>10 分钟</span>
        </div>
      </div>
      {data.gpuName ? <div className="sys-gpu">{data.gpuName}</div> : null}
    </div>
  );
}
