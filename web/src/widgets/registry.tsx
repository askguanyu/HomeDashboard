import type { WidgetComponent } from './types';
import { Clock } from './Clock';
import { AnalogClock } from './AnalogClock';
import { Calendar } from './Calendar';
import { Stocks } from './Stocks';
import { Weather } from './Weather';
import { SystemLoad } from './SystemLoad';

export const widgetRegistry: Record<string, WidgetComponent> = {
  clock: Clock,
  'analog-clock': AnalogClock,
  calendar: Calendar,
  stocks: Stocks,
  weather: Weather,
  'system-load': SystemLoad,
};

/** Accessible names for the per-widget <h2> that DashboardGrid paints (visually hidden). */
export const WIDGET_LABELS: Record<string, string> = {
  clock: '时钟',
  'analog-clock': '指针时钟',
  calendar: '日历',
  stocks: '行情',
  weather: '天气',
  'system-load': '服务器负载',
};
export function resolveWidget(type: string): WidgetComponent | null {
  return widgetRegistry[type] ?? null;
}
