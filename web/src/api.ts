export interface Area {
  col: [number, number];
  row: [number, number];
}

export interface WidgetConfig {
  id: string;
  type: string;
  area: Area;
  options?: Record<string, unknown>;
}

export interface DashboardConfig {
  timezone: string;
  locale: string;
  theme: {
    mode: string;
    background: string;
    backgroundMarket?: string;
    backgroundImage: string | null;
    changeColors: string;
  };
  location?: { zip?: string; name?: string };
  widgets: WidgetConfig[];
}

export interface Holiday {
  name: string;
  date: string; // YYYY-MM-DD
  type: 'public' | 'observance';
}

export interface HolidaysResponse {
  country: string;
  year: number;
  holidays: Holiday[];
}

export interface FedEvent {
  date: string; // YYYY-MM-DD
  kind: 'fomc' | 'speech';
  label: string;
  title: string;
  who?: string;
  press?: boolean;
}

export interface FedResponse {
  year: number;
  events: FedEvent[];
}

export interface WeatherDay {
  date: string; // YYYY-MM-DD in location tz
  code: number; // WMO
  text: string;
  hi: number;
  lo: number;
  pop: number | null;
}

export interface WeatherPayload {
  source: 'open-meteo' | 'nws';
  location: { name: string; lat: number; lon: number };
  units: 'imperial' | 'metric';
  current: {
    temp: number;
    feels: number;
    code: number;
    text: string;
    humidity: number | null;
    windSpeed: number | null;
    windDeg: number | null;
    pressure: number | null;
    visibilityMi: number | null;
    sunrise: string;
    sunset: string;
  };
  daily: WeatherDay[];
  updatedAt: number;
  stale: boolean;
}

export interface Quote {
  code: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  currency: string;
  updatedAt: number;
  stale: boolean;
  error?: string;
}

export interface QuotesResponse {
  updatedAt: number;
  quotes: Quote[];
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}
