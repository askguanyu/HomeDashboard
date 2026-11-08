import { useEffect, useState } from 'react';
import { getJson, type DashboardConfig, type FedEvent, type FedResponse, type Holiday, type HolidaysResponse } from './api';
import { tzParts } from './time';
import { Background } from './Background';
import { DashboardGrid } from './DashboardGrid';

export default function App() {
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [fed, setFed] = useState<FedEvent[]>([]);

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
      getJson<FedResponse>(`/api/fed?year=${year}`),
      getJson<FedResponse>(`/api/fed?year=${year + 1}`),
    ])
      .then(([a, b]) => setFed([...a.events, ...b.events]))
      .catch(() => setFed([])); // FOMC-only still works offline; never fatal
  }, [config]);

  if (error) return <div className="fatal">加载失败：{error}（5 秒后自动重试）</div>;
  if (!config) return <div className="boot">Home Dashboard 启动中…</div>;

  return (
    <>
      <Background mode={config.theme?.background ?? 'starry'} image={config.theme?.backgroundImage ?? null} market={config.theme?.backgroundMarket ?? 'en-US'} />
      <DashboardGrid config={config} holidays={holidays} fed={fed} />
    </>
  );
}
