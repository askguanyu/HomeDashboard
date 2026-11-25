import type { ComponentType } from 'react';
import type { DashboardConfig, Holiday, MacroEvent, WidgetConfig } from '../api';

export interface WidgetProps {
  widget: WidgetConfig;
  config: DashboardConfig;
  holidays: Holiday[];
  macro: MacroEvent[];
  /** epoch ms of last successful data refresh; undefined = live/local widget */
  updatedAt?: number;
  stale?: boolean;
}

export type WidgetComponent = ComponentType<WidgetProps>;
