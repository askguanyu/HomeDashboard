import { useNow } from '../hooks';
import { tzParts, ymd } from '../time';
import type { FedEvent, Holiday } from '../api';
import type { WidgetProps } from './types';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** ISO-8601 week number (Monday-based, week 1 contains Jan 4). Screenshot uses these. */
function isoWeek(y: number, m: number, d: number): number {
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3);
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

interface MonthProps {
  year: number;
  month: number; // 1-12
  today: string;
  holidayByDate: Map<string, string>;
  fedByDate: Map<string, FedEvent[]>;
  fedSpanDates: Set<string>;
  weekNumbers: boolean;
}

function Month({ year, month, today, holidayByDate, fedByDate, fedSpanDates, weekNumbers }: MonthProps) {
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  const rowCount = Math.ceil((firstWeekday + daysInMonth) / 7);
  const weeks: number[] = [];
  for (let w = 0; w < rowCount; w++) {
    // date of this row's Sunday; JS normalizes out-of-month values
    const sun = new Date(year, month - 1, 1 - firstWeekday + w * 7);
    weeks.push(isoWeek(sun.getFullYear(), sun.getMonth() + 1, sun.getDate()));
  }

  const cells = [];
  for (let w = 0; w < rowCount; w++) {
    if (weekNumbers) {
      cells.push(
        <div key={`w${w}`} className="cal-weeknum">
          {weeks[w]}
        </div>,
      );
    } else {
      cells.push(<div key={`w${w}`} />);
    }
    for (let c = 0; c < 7; c++) {
      const dnum = 1 - firstWeekday + w * 7 + c;
      if (dnum < 1 || dnum > daysInMonth) {
        cells.push(<div key={`${w}-${c}`} className="cal-cell" />);
        continue;
      }
      const key = ymd(year, month, dnum);
      const holiday = holidayByDate.get(key);
      const fed = fedByDate.get(key);
      const span = fedSpanDates.has(key);
      const fomc = fed?.some((e) => e.kind === 'fomc');
      cells.push(
        <div
          key={`${w}-${c}`}
          className={[
            'cal-cell',
            key === today ? 'today' : '',
            span ? 'cal-span' : '',
            fomc ? 'cal-fomc' : '',
            holiday ? 'cal-hol' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="cal-day">{dnum}</span>
          {(holiday || fed) && (
            <span className="cal-chips">
              {holiday && <span className="cal-holiday">{holiday}</span>}
              {fed?.slice(0, 2).map((e, i) => (
                <span key={i} className={`cal-fed cal-fed-${e.kind}`} title={e.title}>
                  {e.label}
                </span>
              ))}
            </span>
          )}
        </div>,
      );
    }
  }

  return (
    <div className="month">
      <div className="month-title">
        {month}月, {year}
      </div>
      <div className="month-grid">
        <div />
        {WEEKDAYS.map((d) => (
          <div key={d} className="cal-head">
            {d}
          </div>
        ))}
        {cells}
      </div>
    </div>
  );
}

/** Two months stacked vertically (current + next), like the screenshot's right column. */
export function Calendar({ config, holidays, fed, widget }: WidgetProps) {
  const t = tzParts(useNow(), config.timezone);
  const today = ymd(t.year, t.month, t.day);
  const months = Number(widget.options?.months ?? 2);
  const weekNumbers = widget.options?.weekNumbers !== false;
  const showHolidays = widget.options?.showHolidays !== false;
  const showFed = widget.options?.showFed !== false;

  const holidayByDate = new Map<string, string>();
  if (showHolidays) {
    for (const h of holidays) {
      if (h.type === 'public' && !holidayByDate.has(h.date)) holidayByDate.set(h.date, h.name.replace(/ Day$/, ''));
    }
  }

  const fedByDate = new Map<string, FedEvent[]>();
  const fedSpanDates = new Set<string>();
  if (showFed) {
    for (const e of fed) {
      const arr = fedByDate.get(e.date) ?? [];
      arr.push(e);
      fedByDate.set(e.date, arr);
    }
    for (const v of fedByDate.values()) v.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'fomc' ? -1 : 1));
    for (const e of fed.filter((x) => x.kind === 'fomc')) {
      const start = e.title.match(/meeting (\d{4}-\d\d-\d\d)/);
      if (!start) continue;
      for (const d of dayRange(start[1], e.date)) fedSpanDates.add(d);
    }
  }

  const list = [];
  for (let i = 0; i < months; i++) {
    const m = t.month + i;
    list.push(
      <Month
        key={i}
        year={t.year + Math.floor((m - 1) / 12)}
        month={((m - 1) % 12) + 1}
        today={today}
        weekNumbers={weekNumbers}
        holidayByDate={holidayByDate}
        fedByDate={fedByDate}
        fedSpanDates={fedSpanDates}
      />,
    );
  }

  return <div className="calendar">{list}</div>;
}

/** Inclusive YYYY-MM-DD list from a to b (b >= a); UTC so DST can't shift days. */
function dayRange(a: string, b: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${a}T00:00:00Z`);
  const end = new Date(`${b}T00:00:00Z`);
  while (cur <= end && out.length < 10) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
