import { useNow } from '../hooks';
import { tzParts } from '../time';
import type { WidgetProps } from './types';

function Hand({ deg, width, len, sec }: { deg: number; width: number; len: number; sec?: boolean }) {
  return (
    <line
      className={sec ? 'hand-sec' : undefined}
      x1={50}
      y1={50}
      x2={50}
      y2={50 - len}
      strokeWidth={width}
      transform={`rotate(${deg} 50 50)`}
    />
  );
}

/** Minimal white-ring dial, no tick marks — matches the screenshot's top-left clock. */
export function AnalogClock({ config, widget }: WidgetProps) {
  const t = tzParts(useNow(), config.timezone);
  const secondsHand = widget.options?.secondsHand !== false;
  return (
    <svg className="analog" viewBox="0 0 100 100" preserveAspectRatio="xMinYMin meet" aria-hidden>
      <circle className="ring" cx={50} cy={50} r={49} />
      <Hand deg={(t.hour % 12) * 30 + t.minute * 0.5} width={3.2} len={24} />
      <Hand deg={t.minute * 6 + t.second * 0.1} width={2} len={34} />
      {secondsHand && <Hand deg={t.second * 6} width={1} len={40} sec />}
      <circle className="hub" cx={50} cy={50} r={2} />
    </svg>
  );
}
