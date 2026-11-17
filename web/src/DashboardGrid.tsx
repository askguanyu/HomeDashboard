import type { DashboardConfig, FedEvent, Holiday } from './api';
import { ComingSoon } from './widgets/Placeholder';
import { ErrorBoundary } from './widgets/ErrorBoundary';
import { resolveWidget, WIDGET_LABELS } from './widgets/registry';
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
    <main className="grid">
      <h1 className="visually-hidden">Home Dashboard</h1>
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
            <h2 className="visually-hidden">{WIDGET_LABELS[w.type] ?? w.type}</h2>
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
    </main>
  );
}
