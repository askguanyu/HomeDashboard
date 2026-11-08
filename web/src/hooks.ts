import { useEffect, useState } from 'react';

/** Re-render every second, aligned-ish; widgets read fresh parts from the returned Date. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Poll an endpoint; keeps last good payload when a refresh fails (failing=true → stale UI). */
export function usePoll<T>(url: string, intervalMs: number): { data: T | null; failing: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [failing, setFailing] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
        const j = (await r.json()) as T;
        if (alive) {
          setData(j);
          setFailing(false);
        }
      } catch {
        if (alive) setFailing(true);
      } finally {
        if (alive) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url, intervalMs]);
  return { data, failing };
}
