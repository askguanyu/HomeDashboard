import fs from 'node:fs';
import path from 'node:path';

export interface Area {
  /** [start, end) CSS grid line, 1..13 */
  col: [number, number];
  /** [start, end) CSS grid line, 1..8 */
  row: [number, number];
}

export interface WidgetConfig {
  id: string;
  type: string;
  area: Area;
  options?: Record<string, unknown>;
}

export interface DashboardConfig {
  timezone: string;
  locale: string;
  theme: {
    mode: string;
    background: string;
    backgroundMarket?: string;
    backgroundImage: string | null;
    changeColors: string;
  };
  location?: { zip?: string; name?: string; lat?: number; lon?: number };
  widgets: WidgetConfig[];
}

let cache: { mtimeMs: number; config: DashboardConfig } | null = null;

export function loadConfig(root: string): DashboardConfig {
  const file = path.join(root, 'config', 'dashboard.json');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(
      'config/dashboard.json not found — copy config/dashboard.example.json to config/dashboard.json and edit it. ' +
        'The real config is local-only (gitignored) because it holds your ZIP code, watchlist, and calendar URLs.',
    );
  }
  if (cache && cache.mtimeMs === st.mtimeMs) return cache.config;

  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as DashboardConfig;
  if (!raw.timezone) throw new Error('dashboard.json: missing timezone');
  if (!Array.isArray(raw.widgets) || raw.widgets.length === 0) {
    throw new Error('dashboard.json: widgets[] required');
  }
  for (const w of raw.widgets) {
    if (!w.id || !w.type || !w.area) {
      throw new Error(`dashboard.json: widget missing id/type/area: ${JSON.stringify(w).slice(0, 80)}`);
    }
    const [c0, c1] = w.area.col;
    const [r0, r1] = w.area.row;
    if (!(c0 >= 1 && c1 <= 13 && c0 < c1 && r0 >= 1 && r1 <= 8 && r0 < r1)) {
      throw new Error(`dashboard.json: widget "${w.id}" area out of bounds (col 1-13, row 1-8): ${JSON.stringify(w.area)}`);
    }
  }

  cache = { mtimeMs: st.mtimeMs, config: raw };
  return raw;
}
