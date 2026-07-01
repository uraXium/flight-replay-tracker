import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import planeIconUrl from "@/assets/plane.svg";
import { fetchTraffic, fetchUserTrail } from "@/lib/pf-server";
import type { Plane, LocationData, TouchdownData } from "@/lib/pf-proto";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Project-Flight Live Tracker" },
      { name: "description", content: "Live PTFS traffic from tracker.project-flight.com — real trails from official API." },
    ],
  }),
  component: Index,
});

// pfreplay tile affine (same coord system as PF): lat = -0.00072*y - 67.5, lng = 0.00072*x + 120
const worldToLatLng = (x: number, y: number): [number, number] => [
  -0.00072 * y - 67.5,
  0.00072 * x + 120,
];

type Phase = "air" | "taxi" | "park";
const derivePhase = (alt: number, spd: number): Phase => {
  if (alt > 200 || spd > 60) return "air";
  if (spd > 3) return "taxi";
  return "park";
};
const phaseColor: Record<Phase, string> = { air: "#fbbf24", taxi: "#f97316", park: "#64748b" };
const phaseLabel: Record<Phase, string> = { air: "Airborne", taxi: "Taxi", park: "Parked" };

// FR24 altitude palette
const altColor = (alt: number) => {
  if (alt < 500) return "#cbd5e1";
  if (alt < 10000) return "#22c55e";
  if (alt < 20000) return "#eab308";
  if (alt < 30000) return "#f97316";
  if (alt < 40000) return "#ef4444";
  return "#d946ef";
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
};

type Track = {
  fromX: number; fromY: number; fromH: number;
  toX: number;   toY: number;   toH: number;
  t0: number; dur: number;
  p: Plane;
  marker: any;
};

function Index() {
  const [planes, setPlanes] = useState<Plane[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<"All" | Phase>("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trail, setTrail] = useState<{ locations: LocationData[]; touchdowns: TouchdownData[] } | null>(null);

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const LRef = useRef<any>(null);
  const tracks = useRef<Map<string, Track>>(new Map());
  const routeLayerRef = useRef<any>(null);
  const lastPollAt = useRef(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // Init Leaflet
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !mapEl.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(mapEl.current, {
        crs: L.CRS.Simple,
        minZoom: 2,
        maxZoom: 11,
        zoomControl: true,
        attributionControl: false,
      }).setView([-56, 96], 4);
      L.tileLayer("https://pfreplay.com/api/tiles/{z}/{x}/{y}.webp?v=3", {
        tileSize: 256,
        minZoom: 2,
        maxZoom: 11,
        maxNativeZoom: 8,
        noWrap: true,
        bounds: L.latLngBounds([-112, 16], [0, 176]),
        keepBuffer: 8,
      }).addTo(map);
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Poll traffic every 5s (matches project-flight cadence)
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const list = await fetchTraffic();
        if (!alive) return;
        const now = performance.now();
        const observed = lastPollAt.current ? Math.min(8000, Math.max(1500, now - lastPollAt.current)) : 5000;
        lastPollAt.current = now;
        const dur = Math.min(7000, observed * 1.2);

        setPlanes(list);

        const L = LRef.current; const map = mapRef.current;
        if (L && map) {
          const seen = new Set<string>();
          for (const p of list) {
            const id = p.server_id + ":" + p.roblox_username;
            seen.add(id);
            const existing = tracks.current.get(id);
            if (existing) {
              const k = existing.dur > 0 ? Math.min(1, (now - existing.t0) / existing.dur) : 1;
              existing.fromX = lerp(existing.fromX, existing.toX, k);
              existing.fromY = lerp(existing.fromY, existing.toY, k);
              existing.fromH = lerpAngle(existing.fromH, existing.toH, k);
              existing.toX = p.x; existing.toY = p.y; existing.toH = p.heading;
              existing.t0 = now; existing.dur = dur;
              existing.p = p;
            } else {
              const html = `<div class="pf-plane-wrap" style="transform:rotate(${p.heading}deg)"><img src="${planeIconUrl}" style="width:22px;height:22px;filter:drop-shadow(0 0 2px rgba(0,0,0,.9));"/></div>`;
              const ph = derivePhase(p.altitude, p.speed);
              const icon = L.divIcon({
                className: `pf-marker pf-${ph}`,
                html,
                iconSize: [22, 22],
                iconAnchor: [11, 11],
              });
              const m = L.marker(worldToLatLng(p.x, p.y), { icon, riseOnHover: true })
                .bindTooltip(`${p.callsign} · ${p.model}`, { direction: "top", offset: [0, -8] })
                .addTo(map)
                .on("click", () => setSelectedId(id));
              tracks.current.set(id, {
                fromX: p.x, fromY: p.y, fromH: p.heading,
                toX: p.x, toY: p.y, toH: p.heading,
                t0: now, dur: 0, p, marker: m,
              });
            }
          }
          for (const [id, t] of tracks.current) {
            if (!seen.has(id)) {
              map.removeLayer(t.marker);
              tracks.current.delete(id);
              if (selectedRef.current === id) { setSelectedId(null); setTrail(null); }
            }
          }
          // update marker classes
          for (const [id, t] of tracks.current) {
            const el = t.marker.getElement() as HTMLElement | null;
            if (!el) continue;
            const ph = derivePhase(t.p.altitude, t.p.speed);
            el.classList.remove("pf-air", "pf-taxi", "pf-park");
            el.classList.add(`pf-${ph}`);
            el.classList.toggle("pf-selected", selectedRef.current === id);
          }
        }
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // rAF animation
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      for (const [, t] of tracks.current) {
        const k = t.dur > 0 ? Math.min(1, (now - t.t0) / t.dur) : 1;
        const x = lerp(t.fromX, t.toX, k);
        const y = lerp(t.fromY, t.toY, k);
        const h = lerpAngle(t.fromH, t.toH, k);
        t.marker.setLatLng(worldToLatLng(x, y));
        const el = t.marker.getElement();
        if (el) {
          const wrap = el.querySelector(".pf-plane-wrap") as HTMLElement | null;
          if (wrap) wrap.style.transform = `rotate(${h}deg)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // When selection changes, poll user trail
  useEffect(() => {
    if (!selectedId) { setTrail(null); return; }
    const track = tracks.current.get(selectedId);
    if (!track) return;
    const username = track.p.roblox_username;
    let alive = true;
    let iv: any;
    async function pull() {
      try {
        const d = await fetchUserTrail({ data: { username } });
        if (alive) setTrail({ locations: d.locations ?? [], touchdowns: d.touchdowns ?? [] });
      } catch { /* ignore */ }
    }
    pull();
    iv = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [selectedId]);

  // Draw trail whenever trail/selection updates
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!L || !map) return;
    if (routeLayerRef.current) { map.removeLayer(routeLayerRef.current); routeLayerRef.current = null; }
    if (!selectedId || !trail) return;
    const track = tracks.current.get(selectedId);
    if (!track) return;

    const layer = L.layerGroup();
    const pts = [...trail.locations, { x: track.toX, y: track.toY, altitude: track.p.altitude, speed: track.p.speed }];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.hypot(a.x - b.x, a.y - b.y) > 50000) continue;
      const avgAlt = ((a.altitude ?? 0) + (b.altitude ?? 0)) / 2;
      L.polyline([worldToLatLng(a.x, a.y), worldToLatLng(b.x, b.y)], {
        color: altColor(avgAlt),
        weight: 3,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(layer);
    }

    for (const t of trail.touchdowns ?? []) {
      L.circleMarker(worldToLatLng(t.x, t.y), {
        radius: 5, color: "#f97316", weight: 2, fillColor: "#fef3c7", fillOpacity: 1,
      })
        .bindTooltip(`Touchdown ${t.airport}${t.runway ? ` RWY${t.runway}` : ""} · ${Math.round(t.fpm)} fpm`, { direction: "top" })
        .addTo(layer);
    }

    layer.addTo(map);
    routeLayerRef.current = layer;
  }, [trail, selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return planes.filter((p) => {
      const ph = derivePhase(p.altitude, p.speed);
      if (phaseFilter !== "All" && ph !== phaseFilter) return false;
      if (!q) return true;
      return (
        p.callsign.toLowerCase().includes(q) ||
        p.roblox_username.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q) ||
        p.livery.toLowerCase().includes(q) ||
        p.server_id.toLowerCase().includes(q)
      );
    }).sort((a, b) => a.callsign.localeCompare(b.callsign));
  }, [planes, query, phaseFilter]);

  const focus = (id: string) => {
    const t = tracks.current.get(id);
    if (!t || !mapRef.current) return;
    mapRef.current.setView(worldToLatLng(t.toX, t.toY), Math.max(mapRef.current.getZoom(), 6), { animate: true });
    setSelectedId(id);
  };

  const sel = selectedId ? tracks.current.get(selectedId)?.p ?? null : null;
  const counts = useMemo(() => {
    const c = { air: 0, taxi: 0, park: 0 };
    for (const p of planes) c[derivePhase(p.altitude, p.speed)]++;
    return c;
  }, [planes]);

  return (
    <div className="h-screen w-screen bg-[#0a0d14] text-slate-100 flex flex-col">
      <style>{`
        .pf-marker .pf-plane-wrap { width:22px; height:22px; transition: transform .25s linear; }
        .pf-air img   { filter: drop-shadow(0 0 3px rgba(245,166,35,.85)) brightness(1.05) !important; }
        .pf-taxi img  { filter: drop-shadow(0 0 3px rgba(249,115,22,.85)) hue-rotate(-25deg) !important; }
        .pf-park img  { filter: drop-shadow(0 0 2px rgba(100,116,139,.8)) grayscale(.7) opacity(.7) !important; }
        .pf-selected img { filter: drop-shadow(0 0 6px #38bdf8) brightness(1.2) !important; }
        .leaflet-tooltip { background:#0a0f1a; color:#f1f5f9; border:1px solid rgba(255,255,255,.15); font-size:11px; }
      `}</style>
      <header className="border-b border-white/5 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Project-Flight Live · Official API</h1>
          <p className="text-[10px] text-slate-400">api.project-flight.com/v3/traffic · real trails from /fetch/&lt;user&gt; · tiles: pfreplay</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#fbbf24]" />{counts.air} air</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#f97316]" />{counts.taxi} taxi</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#64748b]" />{counts.park} parked</span>
          <span className="inline-flex items-center gap-2 ml-2">
            <span className="size-2 rounded-full bg-sky-400 animate-pulse" />
            {planes.length} planes
          </span>
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 flex-shrink-0">{error}</div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative">
          <div ref={mapEl} className="absolute inset-0 bg-[#0a0f1a]" />
          {sel && (
            <div className="absolute top-2 right-2 z-[500] w-72 rounded-lg border border-white/10 bg-[#0a0f1a]/95 backdrop-blur p-3 text-xs shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-sm text-sky-300">{sel.callsign}</div>
                  <div className="text-slate-400">{sel.roblox_username}</div>
                </div>
                <button onClick={() => setSelectedId(null)} className="text-slate-500 hover:text-slate-200">✕</button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-slate-300">
                <div><div className="text-slate-500">Aircraft</div>{sel.model}</div>
                <div><div className="text-slate-500">Livery</div>{sel.livery || "—"}</div>
                <div><div className="text-slate-500">Phase</div>
                  <span style={{ color: phaseColor[derivePhase(sel.altitude, sel.speed)] }}>
                    {phaseLabel[derivePhase(sel.altitude, sel.speed)]}
                  </span>
                </div>
                <div><div className="text-slate-500">Server</div><span className="font-mono">{sel.server_id}</span></div>
                <div><div className="text-slate-500">Alt</div>{Math.round(sel.altitude).toLocaleString()} ft</div>
                <div><div className="text-slate-500">Spd</div>{Math.round(sel.speed)} kt</div>
                <div><div className="text-slate-500">Hdg</div>{Math.round(sel.heading)}°</div>
                <div><div className="text-slate-500">Trail pts</div>{trail?.locations.length ?? 0}</div>
              </div>
              {trail && trail.touchdowns.length > 0 && (
                <div className="mt-3 border-t border-white/10 pt-2">
                  <div className="text-slate-500 mb-1">Touchdowns</div>
                  {trail.touchdowns.slice(-3).map((t, i) => (
                    <div key={i} className="text-[10px] text-slate-300 flex justify-between">
                      <span className="font-mono text-[#f97316]">{t.airport} {t.runway && `RWY${t.runway}`}</span>
                      <span className="text-slate-400">{Math.round(t.fpm)} fpm</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="w-[340px] border-l border-white/5 bg-[#0a0f1a] flex flex-col min-h-0">
          <div className="p-2 flex gap-2 border-b border-white/5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search callsign, user, aircraft…"
              className="flex-1 bg-[#070a13] border border-white/10 rounded px-2 py-1 text-xs placeholder:text-slate-500 focus:outline-none focus:border-yellow-500"
            />
            <select
              value={phaseFilter}
              onChange={(e) => setPhaseFilter(e.target.value as any)}
              className="bg-[#070a13] border border-white/10 rounded px-1 py-1 text-xs"
            >
              <option value="All">All</option>
              <option value="air">Airborne</option>
              <option value="taxi">Taxi</option>
              <option value="park">Parked</option>
            </select>
          </div>
          <div className="px-2 py-1 text-[10px] text-slate-500 border-b border-white/5">{filtered.length} shown</div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-[11px]">
              <tbody>
                {filtered.map((p) => {
                  const id = p.server_id + ":" + p.roblox_username;
                  const ph = derivePhase(p.altitude, p.speed);
                  return (
                    <tr
                      key={id}
                      onClick={() => focus(id)}
                      className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${selectedId === id ? "bg-sky-500/10" : ""}`}
                    >
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block size-2 rounded-full" style={{ background: phaseColor[ph] }} />
                          <span className="font-medium text-slate-100">{p.callsign}</span>
                        </div>
                        <div className="text-slate-500 truncate">{p.model} · {p.roblox_username}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">
                        <div>{Math.round(p.altitude ?? 0).toLocaleString()}<span className="text-slate-500"> ft</span></div>
                        <div className="text-slate-500">{Math.round(p.speed ?? 0)} kt</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </div>
  );
}
