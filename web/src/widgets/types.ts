import type { ComponentType } from 'react';
import type { DashboardConfig, FedEvent, Holiday, WidgetConfig } from '../api';

export interface WidgetProps {
  widget: WidgetConfig;
  config: DashboardConfig;
  holidays: Holiday[];
  fed: FedEvent[];
  /** epoch ms of last successful data refresh; undefined = live/local widget */
  updatedAt?: number;
  stale?: boolean;
}

export type WidgetComponent = ComponentType<WidgetProps>;
