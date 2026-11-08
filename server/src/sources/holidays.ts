import Holidays from 'date-holidays';

export interface Holiday {
  name: string;
  date: string; // YYYY-MM-DD
  type: 'public' | 'observance';
}

const cache = new Map<string, { country: string; year: number; holidays: Holiday[] }>();

export function getHolidays(country: string, year: number) {
  const key = `${country}:${year}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const h = new Holidays(country);
  const holidays: Holiday[] = h
    .getHolidays(year)
    .filter((e) => e.type === 'public' || e.type === 'observance')
    .map((e) => ({
      name: e.name,
      date: e.date.slice(0, 10), // "YYYY-MM-DD hh:mm:ss ±hh:mm" -> YYYY-MM-DD (local calendar date)
      type: e.type as 'public' | 'observance',
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const result = { country, year, holidays };
  cache.set(key, result);
  return result;
}
