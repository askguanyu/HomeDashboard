import { useNow } from '../hooks';
import { p2, tzParts, ymd } from '../time';
import type { WidgetProps } from './types';

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function daypartZh(hour: number): string {
  if (hour < 5) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
}

export function Clock({ config, holidays }: WidgetProps) {
  const now = useNow();
  const t = tzParts(now, config.timezone);
  const today = ymd(t.year, t.month, t.day);
  const holiday = holidays.find((h) => h.date === today && h.type === 'public');
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return (
    <div className="clock">
      <div className="clock-main">
        <span className="clock-hm">
          {h12}:{p2(t.minute)}
        </span>
        <span className="clock-side">
          <span className="clock-sec">{p2(t.second)}</span>
          <span className="clock-daypart">{daypartZh(t.hour)}</span>
        </span>
      </div>
      <div className="clock-date">
        {WEEKDAY_ZH[t.weekday]} {t.month}/{p2(t.day)}
      </div>
      {holiday && <div className="clock-holiday">{holiday.name}</div>}
    </div>
  );
}
