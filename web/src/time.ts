export interface TzParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0=Sun
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts in `timeZone` (DST-safe; never the browser's own zone). */
export function tzParts(now: Date, timeZone: string): TzParts {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(timeZone, f);
  }
  const parts = f.formatToParts(now);
  const val = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(val('weekday'));
  return {
    year: Number(val('year')),
    month: Number(val('month')),
    day: Number(val('day')),
    hour: Number(val('hour')) % 24,
    minute: Number(val('minute')),
    second: Number(val('second')),
    weekday: weekday < 0 ? now.getDay() : weekday,
  };
}

export const p2 = (n: number) => String(n).padStart(2, '0');

export const ymd = (year: number, month: number, day: number) => `${year}-${p2(month)}-${p2(day)}`;
