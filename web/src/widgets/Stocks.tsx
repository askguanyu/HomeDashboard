import { usePoll } from '../hooks';
import type { Quote, QuotesResponse } from '../api';
import type { WidgetProps } from './types';

interface SymCfg {
  code: string;
  /** optional display override, e.g. BTC-USD → BTC */
  label?: string;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  return n.toLocaleString('en-US', { minimumFractionDigits: abs >= 100 ? 1 : 2, maximumFractionDigits: abs >= 100 ? 1 : 2 });
}

function pctText(q: Quote | undefined): string {
  if (!q || !Number.isFinite(q.changePct)) return '—';
  return `${q.change >= 0 ? '▲' : '▼'}${Math.abs(q.changePct).toFixed(2)}%`;
}

function QuoteItem({ label, q, redUp }: { label: string; q: Quote | undefined; redUp: boolean }) {
  const ok = q && Number.isFinite(q.price);
  const up = ok ? q.change >= 0 : true;
  const color = !ok ? 'var(--fg-faint)' : up ? (redUp ? 'var(--down)' : 'var(--up)') : redUp ? 'var(--up)' : 'var(--down)';
  return (
    <span className={`quote${q?.stale || !ok ? ' dim' : ''}`}>
      <span className="q-name">{label}</span>
      <span className="q-price">{ok ? fmt(q.price) : '--'}</span>
      <span className="q-pct" style={{ color }}>
        {pctText(q)}
      </span>
    </span>
  );
}

export function Stocks({ widget, config }: WidgetProps) {
  const opts = widget.options ?? {};
  const syms = ((opts.symbols as SymCfg[] | undefined) ?? []).filter((s) => s?.code);
  const style = String(opts.style ?? 'grid');
  const redUp = config.theme?.changeColors === 'red-up';
  const url = `/api/quotes?symbols=${syms.map((s) => encodeURIComponent(s.code)).join(',')}`;
  const { data, failing } = usePoll<QuotesResponse>(url, 60_000);

  if (!syms.length) return null;
  const byCode = new Map((data?.quotes ?? []).map((q) => [q.code.toUpperCase(), q]));
  const entries = syms.map((s) => ({ code: s.code, label: s.label || s.code, q: byCode.get(s.code.toUpperCase()) }));
  const stale = failing || (data?.quotes ?? []).some((q) => q.stale);

  if (style === 'tape') {
    // 固定行情条:每行 quotesPerRow(默认 3)个品种,整行排列不滚动
    const perRow = Math.max(1, Number(opts.quotesPerRow ?? 3));
    const rows: number[][] = [];
    for (let i = 0; i < entries.length; i += perRow) {
      rows.push(Array.from({ length: Math.min(perRow, entries.length - i) }, (_, k) => i + k));
    }
    return (
      <div className="tape">
        {stale ? <div className="stale-badge">缓存</div> : null}
        <div className="tape-rows">
          {rows.map((row, i) => (
            <div className="tape-row" key={i}>
              {row.map((idx) => (
                <QuoteItem key={entries[idx].code} label={entries[idx].label} q={entries[idx].q} redUp={redUp} />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }
  const cols = Number(opts.columnsPerRow ?? 4);
  return (
    <div className="qgrid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {stale ? <div className="stale-badge">缓存</div> : null}
      {entries.map((e) => (
        <QuoteItem key={e.code} label={e.label} q={e.q} redUp={redUp} />
      ))}
    </div>
  );
}
