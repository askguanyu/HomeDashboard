import { useEffect, useState } from 'react';
import { getJson, type DashboardConfig, type Holiday, type HolidaysResponse, type MacroEvent, type MacroResponse } from './api';
import { tzParts } from './time';
import { Background } from './Background';
import { DashboardGrid } from './DashboardGrid';

export default function App() {
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [macro, setMacro] = useState<MacroEvent[]>([]);

  useEffect(() => {
    getJson<DashboardConfig>('/api/config').then(setConfig).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (error) {
      const id = setTimeout(() => location.reload(), 5000);
      return () => clearTimeout(id);
    }
  }, [error]);

  useEffect(() => {
    if (!config) return;
    const { year } = tzParts(new Date(), config.timezone);
    Promise.all([
      getJson<HolidaysResponse>(`/api/holidays?year=${year}&country=US`),
      getJson<HolidaysResponse>(`/api/holidays?year=${year + 1}&country=US`),
    ])
        .then(([a, b]) => setHolidays([...a.holidays, ...b.holidays]))
        .catch(() => setHolidays([])); // calendar still renders without holiday labels
    Promise.all([
      getJson<MacroResponse>(`/api/macro?year=${year}`).catch(() => null),
      getJson<MacroResponse>(`/api/macro?year=${year + 1}`).catch(() => null),
    ]).then(([a, b]) => {
      const events = [...(a?.events ?? []), ...(b?.events ?? [])];
      if (events.length) setMacro(events);
    });
  }, [config]);

  if (error) return <div className="fatal" role="alert">加载失败：{error}（5 秒后自动重试）</div>;
  if (!config) return <div className="boot">Home Dashboard 启动中…</div>;

  return (
    <>
      <Background mode={config.theme?.background ?? 'starry'} image={config.theme?.backgroundImage ?? null} market={config.theme?.backgroundMarket ?? 'en-US'} />
      <DashboardGrid config={config} holidays={holidays} macro={macro} />
    </>
  );
}
