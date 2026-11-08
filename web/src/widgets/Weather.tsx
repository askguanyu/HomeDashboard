import { usePoll } from '../hooks';
import type { WeatherPayload } from '../api';
import type { WidgetProps } from './types';

const ICONS: Record<number, string> = {
  0: '☀️',
  1: '🌤️',
  2: '⛅',
  3: '☁️',
  45: '🌫️',
  48: '🌫️',
  51: '🌦️',
  53: '🌦️',
  55: '🌦️',
  56: '🌧️',
  57: '🌧️',
  61: '🌧️',
  63: '🌧️',
  65: '🌧️',
  66: '🌧️',
  67: '🌧️',
  71: '🌨️',
  73: '🌨️',
  75: '❄️',
  77: '🌨️',
  80: '🌦️',
  81: '🌧️',
  82: '⛈️',
  85: '🌨️',
  86: '❄️',
  95: '⛈️',
  96: '⛈️',
  99: '⛈️',
};

function icon(code: number): string {
  return ICONS[code] ?? '🌡️';
}

const WIND_DIRS = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'];

function windLabel(deg: number | null, speed: number | null, units: string): string | null {
  if (speed == null) return null;
  const dir = deg == null ? '' : WIND_DIRS[Math.round(deg / 45) % 8];
  return `${dir} ${Math.round(speed)}\u00a0${units === 'metric' ? 'km/h' : 'mph'}`;
}

const WEEKDAY = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
export function Weather({ widget }: WidgetProps) {
  const opts = widget.options ?? {};
  const details = (opts.details as string[] | undefined) ?? ['sunrise', 'wind', 'humidity', 'pressure', 'visibility'];
  const days = Number(opts.forecastDays ?? 5);
  const units = opts.units === 'metric' ? 'metric' : 'imperial';
  const { data, failing } = usePoll<WeatherPayload>(`/api/weather?units=${units}&days=${days}`, 10 * 60_000);

  if (!data) {
    return (
      <div className="placeholder">
        <div className="placeholder-title">天气</div>
        <div className="placeholder-note">{failing ? '暂时无法获取' : '加载中…'}</div>
      </div>
    );
  }
  const c = data.current;
  const today = data.daily[0];
  const wind = windLabel(c.windDeg, c.windSpeed, data.units);
  const detailBits: string[] = [];
  if (details.includes('sunrise') && c.sunrise !== '--:--') detailBits.push(`日出 ${c.sunrise} · 日落 ${c.sunset}`);
  if (details.includes('wind') && wind) detailBits.push(wind);
  if (details.includes('humidity') && c.humidity != null) detailBits.push(`湿度 ${Math.round(c.humidity)}%`);
  if (details.includes('pressure') && c.pressure != null) detailBits.push(`${Math.round(c.pressure)}\u00a0hPa`);
  if (details.includes('visibility') && c.visibilityMi != null)
    detailBits.push(data.units === 'metric' ? `能见度 ${(c.visibilityMi * 1.609).toFixed(1)}\u00a0km` : `能见度 ${c.visibilityMi.toFixed(1)}\u00a0mi`);
  const deg = data.units === 'metric' ? '°C' : '°F';

  // 折成两行:在「·」分隔处断开,两行字符数尽量接近
  const detailLines = (() => {
    if (detailBits.length < 2) return detailBits;
    let best = 1;
    let bestDiff = Infinity;
    for (let i = 1; i < detailBits.length; i++) {
      const diff = Math.abs(detailBits.slice(0, i).join(' · ').length - detailBits.slice(i).join(' · ').length);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return [detailBits.slice(0, best).join('  ·  '), detailBits.slice(best).join('  ·  ')];
  })();

  return (
    <div className="weather">
      {data.stale || failing ? <div className="stale-badge">缓存数据</div> : null}
      <div className="wx-now">
        <span className="wx-icon">{icon(c.code)}</span>
        <div className="wx-temp">
          {c.temp}
          <span className="wx-unit">{deg}</span>
        </div>
        <div className="wx-meta">
          <div className="wx-text">{c.text}</div>
          <div className="wx-feels">
            体感 {c.feels}{deg}
            {today ? ` · 今天 ${today.lo}~${today.hi}${deg}` : ''}
          </div>
        </div>
      </div>
      <div className="wx-details">{detailLines.map((line) => <div key={line}>{line}</div>)}</div>
      <div className="wx-days">
        {data.daily.slice(1).map((d) => (
          <div className="wx-day" key={d.date}>
            <div className="wx-dow">{WEEKDAY.format(new Date(`${d.date}T12:00:00`))}</div>
            <div className="wx-dicon">{icon(d.code)}</div>
            <div className="wx-dtemps">
              <b>{d.hi}</b>
              <span>{d.lo}</span>
            </div>
            <div className={`wx-dpop${d.pop != null && d.pop >= 30 ? ' wet' : ''}`}>{d.pop != null && d.pop >= 10 ? `${d.pop}%` : '\u00a0'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
