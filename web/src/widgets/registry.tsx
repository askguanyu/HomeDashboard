import type { WidgetComponent } from './types';
import { Clock } from './Clock';
import { AnalogClock } from './AnalogClock';
import { Calendar } from './Calendar';
import { Stocks } from './Stocks';
import { Weather } from './Weather';

export const widgetRegistry: Record<string, WidgetComponent> = {
  clock: Clock,
  'analog-clock': AnalogClock,
  calendar: Calendar,
  stocks: Stocks,
  weather: Weather,
};

/** Accessible names for the per-widget <h2> that DashboardGrid paints (visually hidden). */
export const WIDGET_LABELS: Record<string, string> = {
  clock: '时钟',
  'analog-clock': '指针时钟',
  calendar: '日历',
  stocks: '行情',
  weather: '天气',
};
export function resolveWidget(type: string): WidgetComponent | null {
  return widgetRegistry[type] ?? null;
}
