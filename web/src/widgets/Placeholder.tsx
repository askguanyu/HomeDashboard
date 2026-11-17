import type { WidgetProps } from './types';

export function Placeholder({ title, note, live }: { title: string; note: string; live?: boolean }) {
  return (
    <div className="placeholder" role={live ? 'status' : undefined}>
      <div className="placeholder-title">{title}</div>
      <div className="placeholder-note">{note}</div>
    </div>
  );
}

export function ComingSoon({ widget }: { widget: WidgetProps['widget'] }) {
  return <Placeholder title={widget.id} note={`待接入：${widget.type}`} />;
}
