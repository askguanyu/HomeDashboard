import type { WidgetProps } from './types';

export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="placeholder">
      <div className="placeholder-title">{title}</div>
      <div className="placeholder-note">{note}</div>
    </div>
  );
}

export function ComingSoon({ widget }: { widget: WidgetProps['widget'] }) {
  return <Placeholder title={widget.id} note={`待接入：${widget.type}`} />;
}
