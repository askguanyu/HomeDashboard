import { useEffect, useRef, useState } from 'react';

const STARS = (() => {
  let s = 42;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return Array.from({ length: 170 }, () => ({
    x: rnd() * 100,
    y: rnd() * 100,
    r: 0.06 + rnd() * 0.16,
    o: 0.25 + rnd() * 0.75,
  }));
})();

interface BgInfo {
  key: number;
  total: number;
  item: { id: string; title: string; credit: string; date: string };
  source?: string;
  image: string;
}

function Starry() {
  return (
    <>
      <div className="bg-sky" />
      <svg className="bg-stars" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {STARS.map((st, i) => (
          <circle key={i} cx={st.x} cy={st.y} r={st.r} fill="#fff" opacity={st.o} />
        ))}
      </svg>
      <div className="bg-aurora" />
    </>
  );
}

/** Bing/NASA wallpaper rotation; crossfades, falls back to starry on error. */
function Rotating({ mode, market }: { mode: string; market: string }) {
  const [layers, setLayers] = useState<Array<{ url: string; info: BgInfo; visible: boolean }>>([]);
  const [failed, setFailed] = useState(false);
  const keyRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`/api/background?mode=${encodeURIComponent(mode)}&market=${encodeURIComponent(market)}`);
        if (!r.ok) throw new Error(String(r.status));
        const info = (await r.json()) as BgInfo;
        if (!alive || keyRef.current === info.key) return;
        const probe = new Image();
        // The hour key keeps every rotation a distinct URL: older Chromium (the stick PC's
        // pinned Chrome) can answer a repeat URL straight from its image cache without
        // revalidating, which freezes the wallpaper on the first one. The <link rel="preload">
        // the server injects into index.html carries the same `k=` (see preloadImageUrl),
        // so the first paint still reuses the preloaded bytes; within an hour the id-based
        // ETag on /api/background/image turns reloads into 304s.
        const url = `${info.image}?k=${info.key}&mode=${encodeURIComponent(mode)}&market=${encodeURIComponent(market)}`;
        probe.onload = () => {
          if (!alive) return;
          keyRef.current = info.key;
          setFailed(false);
          setLayers((prev) =>
            [{ url, info, visible: true }, ...prev.map((l) => ({ ...l, visible: false }))].slice(0, 2),
          );
        };
        probe.onerror = () => {
          if (alive && keyRef.current === null) setFailed(true);
        };
        probe.src = url;
      } catch {
        if (alive && keyRef.current === null) setFailed(true);
      }
    };
    // Wallpaper identity changes with mode/market, so forget the last key and refetch.
    keyRef.current = null;
    check();
    const id = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mode, market]);

  if (failed) {
    return (
      <div className="bg">
        <Starry />
      </div>
    );
  }
  // DESIGN.md F10: bottom-right caption = wallpaper title · attribution.
  const top = layers.find((l) => l.visible) ?? layers[0];
  const credit = top ? [top.info.item.title, top.info.item.credit].filter(Boolean).join(' · ') : '';

  return (
    <div className="bg">
      <Starry /> {/* base layer while first image loads / behind fade */}
      {layers.map((l) => (
        <div key={l.info.key} className="bg-photo" style={{ opacity: l.visible ? 1 : 0, backgroundImage: `url("${l.url}")` }} />
      ))}
      <div className="bg-scrim" />
      {credit && <div className="bg-credit">{credit}</div>}
    </div>
  );
}

/** Fullscreen wallpaper: Bing daily/rotate, hourly NASA rotation, user image override, or starry gradient. */
export function Background({ mode, image, market }: { mode: string; image: string | null; market: string }) {
  if (image) {
    return (
      <div className="bg">
        <div className="bg-image" style={{ backgroundImage: `url("${image}")` }} />
        <div className="bg-scrim" />
      </div>
    );
  }
  if (mode === 'nasa-rotate' || mode === 'mix' || mode.startsWith('bing')) return <Rotating mode={mode} market={market} />;
  return (
    <div className="bg">
      <Starry />
    </div>
  );
}
