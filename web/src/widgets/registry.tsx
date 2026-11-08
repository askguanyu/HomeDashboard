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
export function resolveWidget(type: string): WidgetComponent | null {
  return widgetRegistry[type] ?? null;
}
