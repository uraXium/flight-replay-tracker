import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import planeIconUrl from "@/assets/plane.svg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PFReplay Live Flights" },
      { name: "description", content: "Real-time flight tracker pulling live aircraft positions from pfreplay.com." },
    ],
  }),
  component: Index,
});

type Flight = {
  id: number;
  player: string;
  callsign: string;
  aircraft: string;
  livery: string;
  started_at: number;
  last_seen: number;
  dep_code: string | null;
  dep_name: string | null;
  arr_code: string | null;
  arr_name: string | null;
};

type LiveAircraft = {
  callsign: string;
  player: string;
  serverId: string;
  x: number;
  y: number;
  heading: number;
  altitude: number;
  speed: number;
  aircraft: string;
  livery: string;
  phase: string;
  flightId: number;
};

type LiveResponse = { polledAt: number; count: number; aircraft: LiveAircraft[] };

type Airport = { code: string; name: string; x: number; y: number; iata?: string };

// PFReplay affine: lat = -0.00072*y - 67.5, lng = 0.00072*x + 120
const worldToLatLng = (x: number, y: number): [number, number] => [
  -0.00072 * y - 67.5,
  0.00072 * x + 120,
];

// matches pfreplay st-air/st-taxi/st-park
const phaseStyle = (phase?: string) => {
  if (!phase) return { color: "#6b7c8c", label: "parked", group: "park" as const };
  if (["Climbing", "Cruise", "Descending", "Airborne"].includes(phase))
    return { color: "#2ec27e", label: phase, group: "air" as const };
  if (["Taxiing", "On runway"].includes(phase))
    return { color: "#f59e2c", label: phase, group: "taxi" as const };
  return { color: "#6b7c8c", label: phase, group: "park" as const };
};

// shortest-arc angle lerp
const lerpAngle = (a: number, b: number, t: number) => {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * t;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function randomCid() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

type Track = {
  fromX: number; fromY: number; fromH: number;
  toX: number;   toY: number;   toH: number;
  t0: number; dur: number;
  a: LiveAircraft;
  marker: any;
};

function Index() {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [airports, setAirports] = useState<Airport[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<string>("All");
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedAcSnap, setSelectedAcSnap] = useState<LiveAircraft | null>(null);
  const [phaseList, setPhaseList] = useState<string[]>(["All"]);
  const cid = useMemo(randomCid, []);

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const LRef = useRef<any>(null);
  const tracks = useRef<Map<number, Track>>(new Map());
  const history = useRef<Map<number, Array<{ x: number; y: number; alt: number }>>>(new Map());
  const lastPollAt = useRef<number>(0);
  const routeLayerRef = useRef<any>(null);
  const [pollTick, setPollTick] = useState(0);
  const flightsByIdRef = useRef<Map<number, Flight>>(new Map());
  const airportsByCodeRef = useRef<Map<string, Airport>>(new Map());
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;

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
      }).setView([-95, 112], 5);
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

  // Fetch airports once
  useEffect(() => {
    fetch("https://pfreplay.com/api/airports")
      .then((r) => r.json())
      .then((d: Airport[]) => {
        setAirports(d);
        airportsByCodeRef.current = new Map(d.map((a) => [a.code, a]));
      })
      .catch(() => {});
  }, []);

  // Poll
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const [f, l] = await Promise.all([
          fetch("https://pfreplay.com/api/flights?active=1").then((r) => r.json()),
          fetch(`https://pfreplay.com/api/live?cid=${cid}`).then((r) => r.json()),
        ]);
        if (!alive) return;
        const list: LiveResponse = l;
        const now = performance.now();
        const observed = lastPollAt.current ? Math.min(5000, Math.max(800, now - lastPollAt.current)) : 2000;
        lastPollAt.current = now;
        const dur = Math.min(3600, observed * 1.3);

        setFlights(f);
        flightsByIdRef.current = new Map((f as Flight[]).map((x) => [x.id, x]));
        setLiveCount(list.count);

        const L = LRef.current;
        const map = mapRef.current;
        if (L && map) {
          const seen = new Set<number>();
          for (const a of list.aircraft) {
            seen.add(a.flightId);
            // append breadcrumb (dedupe near-identical points)
            const hist = history.current.get(a.flightId) ?? [];
            const last = hist[hist.length - 1];
            if (!last || Math.hypot(last.x - a.x, last.y - a.y) > 80) {
              hist.push({ x: a.x, y: a.y, alt: a.altitude });
              if (hist.length > 600) hist.shift();
              history.current.set(a.flightId, hist);
            } else {
              last.alt = a.altitude;
            }
            const existing = tracks.current.get(a.flightId);
            if (existing) {
              const k = existing.dur > 0 ? Math.min(1, (now - existing.t0) / existing.dur) : 1;
              existing.fromX = lerp(existing.fromX, existing.toX, k);
              existing.fromY = lerp(existing.fromY, existing.toY, k);
              existing.fromH = lerpAngle(existing.fromH, existing.toH, k);
              existing.toX = a.x; existing.toY = a.y; existing.toH = a.heading;
              existing.t0 = now; existing.dur = dur;
              existing.a = a;
            } else {
              const ph = phaseStyle(a.phase);
              const html = `<div class="pf-plane-wrap" style="transform:rotate(${a.heading}deg)"><img src="${planeIconUrl}" style="width:22px;height:22px;filter:drop-shadow(0 0 2px rgba(0,0,0,.9));"/></div>`;
              const icon = L.divIcon({
                className: `pf-marker pf-${ph.group}`,
                html,
                iconSize: [22, 22],
                iconAnchor: [11, 11],
              });
              const m = L.marker(worldToLatLng(a.x, a.y), { icon, riseOnHover: true })
                .addTo(map)
                .on("click", () => setSelected(a.flightId));
              tracks.current.set(a.flightId, {
                fromX: a.x, fromY: a.y, fromH: a.heading,
                toX: a.x, toY: a.y, toH: a.heading,
                t0: now, dur: 0, a, marker: m,
              });
            }
          }
          for (const [id, t] of tracks.current) {
            if (!seen.has(id)) {
              map.removeLayer(t.marker);
              tracks.current.delete(id);
              history.current.delete(id);
              if (selectedRef.current === id) setSelected(null);
            }
          }
        }
        setPollTick((n) => n + 1);

        // collect phase list
        const ps = new Set<string>();
        list.aircraft.forEach((a) => a.phase && ps.add(a.phase));
        setPhaseList(["All", ...Array.from(ps).sort()]);

        // refresh selected snapshot
        if (selectedRef.current != null) {
          const sa = list.aircraft.find((a) => a.flightId === selectedRef.current);
          if (sa) setSelectedAcSnap(sa);
        }
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [cid]);

  // rAF animation loop
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

  // Update marker classes when phase changes
  useEffect(() => {
    for (const [, t] of tracks.current) {
      const el = t.marker.getElement();
      if (!el) continue;
      const ph = phaseStyle(t.a.phase);
      el.classList.remove("pf-air", "pf-taxi", "pf-park");
      el.classList.add(`pf-${ph.group}`);
      el.classList.toggle("pf-selected", selected === t.a.flightId);
    }
  }, [liveCount, selected]);

  // Draw route line for selected flight (dep -> aircraft -> arr)
  useEffect(() => {
    const L = LRef.current; const map = mapRef.current;
    if (!L || !map) return;
    if (routeLayerRef.current) { map.removeLayer(routeLayerRef.current); routeLayerRef.current = null; }
    if (selected == null) return;
    const flight = flightsByIdRef.current.get(selected);
    const track = tracks.current.get(selected);
    if (!flight || !track) return;
    const dep = flight.dep_code ? airportsByCodeRef.current.get(flight.dep_code) : null;
    const arr = flight.arr_code ? airportsByCodeRef.current.get(flight.arr_code) : null;
    const cur: [number, number] = worldToLatLng(track.toX, track.toY);
    const layer = L.layerGroup();
    if (dep) {
      L.polyline([worldToLatLng(dep.x, dep.y), cur], {
        color: "#2ec27e", weight: 2, opacity: 0.85, dashArray: "4,4",
      }).addTo(layer);
      L.circleMarker(worldToLatLng(dep.x, dep.y), {
        radius: 5, color: "#2ec27e", weight: 2, fillColor: "#0f172a", fillOpacity: 1,
      }).bindTooltip(`${dep.code} · ${dep.name}`, { direction: "top" }).addTo(layer);
    }
    if (arr) {
      L.polyline([cur, worldToLatLng(arr.x, arr.y)], {
        color: "#ffd84d", weight: 2, opacity: 0.85, dashArray: "6,4",
      }).addTo(layer);
      L.circleMarker(worldToLatLng(arr.x, arr.y), {
        radius: 5, color: "#ffd84d", weight: 2, fillColor: "#0f172a", fillOpacity: 1,
      }).bindTooltip(`${arr.code} · ${arr.name}`, { direction: "top" }).addTo(layer);
    }
    layer.addTo(map);
    routeLayerRef.current = layer;
  }, [selected, flights, airports]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return flights
      .map((f) => ({ flight: f, pos: Array.from(tracks.current.values()).find((t) => t.a.flightId === f.id)?.a }))
      .filter(({ flight, pos }) => {
        if (phaseFilter !== "All" && pos?.phase !== phaseFilter) return false;
        if (!q) return true;
        return (
          flight.callsign.toLowerCase().includes(q) ||
          flight.player.toLowerCase().includes(q) ||
          flight.aircraft.toLowerCase().includes(q) ||
          (flight.dep_code ?? "").toLowerCase().includes(q) ||
          (flight.arr_code ?? "").toLowerCase().includes(q) ||
          (flight.dep_name ?? "").toLowerCase().includes(q) ||
          (flight.arr_name ?? "").toLowerCase().includes(q)
        );
      });
  }, [flights, query, phaseFilter, liveCount]);

  const focus = (flightId: number) => {
    const t = tracks.current.get(flightId);
    if (!t || !mapRef.current) return;
    mapRef.current.setView(worldToLatLng(t.toX, t.toY), Math.max(mapRef.current.getZoom(), 6), { animate: true });
    setSelected(flightId);
    setSelectedAcSnap(t.a);
  };

  const selectedFlight = selected != null ? flights.find((f) => f.id === selected) : null;
  const selectedAc = selectedAcSnap && selected === selectedAcSnap.flightId ? selectedAcSnap : null;

  return (
    <div className="h-screen w-screen bg-[#05070d] text-slate-100 flex flex-col">
      <style>{`
        .pf-marker .pf-plane-wrap { width:22px; height:22px; transition: transform .25s linear; }
        .pf-marker img { transition: filter .2s; }
        .pf-air img   { filter: drop-shadow(0 0 3px rgba(46,194,126,.9)) brightness(1.05) !important; }
        .pf-taxi img  { filter: drop-shadow(0 0 3px rgba(245,158,44,.9)) hue-rotate(-25deg) !important; }
        .pf-park img  { filter: drop-shadow(0 0 2px rgba(107,124,140,.8)) grayscale(.7) opacity(.7) !important; }
        .pf-selected img { filter: drop-shadow(0 0 6px #ffd84d) brightness(1.2) !important; }
        .leaflet-tooltip { background:#0a0f1a; color:#f1f5f9; border:1px solid rgba(255,255,255,.15); font-size:11px; }
      `}</style>
      <header className="border-b border-white/5 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">PFReplay Live · FR24-style</h1>
          <p className="text-[10px] text-slate-400">Tiles & data: pfreplay.com · interpolated @ 60fps</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#2ec27e]" />Airborne</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#f59e2c]" />Taxi</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#6b7c8c]" />Parked</span>
          <span className="inline-flex items-center gap-2 ml-2">
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            {liveCount} live · {flights.length} flights
          </span>
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 flex-shrink-0">{error}</div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative">
          <div ref={mapEl} className="absolute inset-0 bg-[#0a0f1a]" />
          {selectedAc && selectedFlight && (
            <div className="absolute top-2 right-2 z-[500] w-72 rounded-lg border border-white/10 bg-[#0a0f1a]/95 backdrop-blur p-3 text-xs shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-sm">{selectedFlight.callsign}</div>
                  <div className="text-slate-400">{selectedFlight.player}</div>
                </div>
                <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-slate-200">✕</button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-slate-300">
                <div><div className="text-slate-500">Aircraft</div>{selectedAc.aircraft}</div>
                <div><div className="text-slate-500">Livery</div>{selectedAc.livery}</div>
                <div><div className="text-slate-500">Phase</div><span style={{ color: phaseStyle(selectedAc.phase).color }}>{selectedAc.phase}</span></div>
                <div><div className="text-slate-500">Server</div>{selectedAc.serverId}</div>
                <div><div className="text-slate-500">Alt</div>{selectedAc.altitude.toLocaleString()} ft</div>
                <div><div className="text-slate-500">Spd</div>{selectedAc.speed} kt</div>
                <div><div className="text-slate-500">Hdg</div>{Math.round(selectedAc.heading)}°</div>
                <div><div className="text-slate-500">Flight ID</div>{selectedAc.flightId}</div>
              </div>
              <div className="mt-3 border-t border-white/10 pt-2">
                <div className="text-slate-500 mb-1">Route</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[#2ec27e]">{selectedFlight.dep_code ?? "—"}</div>
                    <div className="text-slate-400 text-[10px] truncate">{selectedFlight.dep_name ?? "Unknown departure"}</div>
                  </div>
                  <div className="text-slate-500">→</div>
                  <div className="min-w-0 text-right">
                    <div className="font-mono text-[#ffd84d]">{selectedFlight.arr_code ?? "—"}</div>
                    <div className="text-slate-400 text-[10px] truncate">{selectedFlight.arr_name ?? "No destination set"}</div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-slate-500">
                  Started {new Date(selectedFlight.started_at).toLocaleTimeString()} · Last seen {new Date(selectedFlight.last_seen).toLocaleTimeString()}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="w-[340px] border-l border-white/5 bg-[#0a0f1a] flex flex-col min-h-0">
          <div className="p-2 flex gap-2 border-b border-white/5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search callsign, player, airport…"
              className="flex-1 bg-[#070a13] border border-white/10 rounded px-2 py-1 text-xs placeholder:text-slate-500 focus:outline-none focus:border-yellow-500"
            />
            <select
              value={phaseFilter}
              onChange={(e) => setPhaseFilter(e.target.value)}
              className="bg-[#070a13] border border-white/10 rounded px-1 py-1 text-xs"
            >
              {phaseList.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="px-2 py-1 text-[10px] text-slate-500 border-b border-white/5">{rows.length} shown</div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-[11px]">
              <tbody>
                {rows.map(({ flight, pos }) => {
                  const ph = phaseStyle(pos?.phase);
                  return (
                    <tr
                      key={flight.id}
                      onClick={() => focus(flight.id)}
                      className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${selected === flight.id ? "bg-yellow-500/10" : ""}`}
                    >
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block size-2 rounded-full" style={{ background: ph.color }} />
                          <span className="font-medium text-slate-100">{flight.callsign}</span>
                        </div>
                        <div className="text-slate-500">{flight.aircraft} · {flight.dep_code ?? "—"}→{flight.arr_code ?? "—"}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">
                        <div>{pos?.altitude.toLocaleString() ?? "—"}<span className="text-slate-500"> ft</span></div>
                        <div className="text-slate-500">{pos?.speed ?? "—"} kt</div>
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
