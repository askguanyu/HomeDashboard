import type { DashboardConfig, FedEvent, Holiday } from './api';
import { ComingSoon } from './widgets/Placeholder';
import { ErrorBoundary } from './widgets/ErrorBoundary';
import { resolveWidget } from './widgets/registry';
export function DashboardGrid({
  config,
  holidays,
  fed,
}: {
  config: DashboardConfig;
  holidays: Holiday[];
  fed: FedEvent[];
}) {
  return (
    <div className="grid">
      {config.widgets.map((w) => {
        const C = resolveWidget(w.type);
        return (
          <div
            key={w.id}
            className="cell"
            style={{
              gridColumn: `${w.area.col[0]} / ${w.area.col[1]}`,
              gridRow: `${w.area.row[0]} / ${w.area.row[1]}`,
            }}
          >
            <ErrorBoundary id={w.id}>
              {C ? (
                <C widget={w} config={config} holidays={holidays} fed={fed} />
              ) : (
                <ComingSoon widget={w} />
              )}
            </ErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}
