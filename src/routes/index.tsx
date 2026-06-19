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
  dep_code: string | null;
  arr_code: string | null;
};

type LiveAircraft = {
  callsign: string;
  player: string;
  x: number;
  y: number;
  heading: number;
  altitude: number;
  speed: number;
  aircraft: string;
  phase: string;
  flightId: number;
};

type LiveResponse = { polledAt: number; count: number; aircraft: LiveAircraft[] };

// PFReplay's affine (from their bundle): world (x,y) -> (lat,lng)
//   lat = -0.00072 * y - 67.5
//   lng =  0.00072 * x + 120
const A = { a: 0, b: -0.00072, c: -67.5, d: 0.00072, e: 0, f: 120 };
const worldToLatLng = (x: number, y: number): [number, number] => [
  A.a * x + A.b * y + A.c,
  A.d * x + A.e * y + A.f,
];

function randomCid() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

function Index() {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<string>("All");
  const [selected, setSelected] = useState<number | null>(null);
  const cid = useMemo(randomCid, []);

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<number, any>>(new Map());
  const LRef = useRef<any>(null);
  const didFitRef = useRef(false);

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
      (window as any).__map = map;
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Poll pfreplay
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const [f, l] = await Promise.all([
          fetch("https://pfreplay.com/api/flights?active=1").then((r) => r.json()),
          fetch(`https://pfreplay.com/api/live?cid=${cid}`).then((r) => r.json()),
        ]);
        if (!alive) return;
        setFlights(f);
        setLive(l);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cid]);

  // Sync markers
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !live) return;

    const seen = new Set<number>();
    for (const a of live.aircraft) {
      seen.add(a.flightId);
      const latlng = worldToLatLng(a.x, a.y);
      const phaseColor =
        a.phase === "Cruise" ? "#facc15"
        : a.phase === "Climbing" ? "#84cc16"
        : a.phase === "Descending" ? "#fb923c"
        : a.phase === "Airborne" ? "#facc15"
        : a.phase === "On runway" ? "#f87171"
        : "#94a3b8";
      const html = `<div style="transform: rotate(${a.heading}deg); width:24px; height:24px;">
        <img src="${planeIconUrl}" style="width:24px;height:24px;filter: drop-shadow(0 0 2px rgba(0,0,0,.8)) hue-rotate(0deg);" />
      </div>`;
      let m = markersRef.current.get(a.flightId);
      if (!m) {
        const icon = L.divIcon({
          className: "pf-plane",
          html,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        m = L.marker(latlng, { icon, riseOnHover: true })
          .addTo(map)
          .on("click", () => setSelected(a.flightId));
        markersRef.current.set(a.flightId, m);
      } else {
        m.setLatLng(latlng);
        m.setIcon(
          L.divIcon({
            className: "pf-plane",
            html: `<div style="transform: rotate(${a.heading}deg); width:24px; height:24px;">
              <img src="${planeIconUrl}" style="width:24px;height:24px;filter: drop-shadow(0 0 2px rgba(0,0,0,.8));" />
            </div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          }),
        );
      }
      m.bindTooltip(
        `<b>${a.callsign}</b><br>${a.aircraft}<br>${a.altitude.toLocaleString()} ft · ${a.speed} kt · ${a.phase}`,
        { direction: "top", offset: [0, -10] },
      );
      void phaseColor;
    }
    for (const [id, m] of markersRef.current) {
      if (!seen.has(id)) {
        map.removeLayer(m);
        markersRef.current.delete(id);
      }
    }
  }, [live]);

  const liveById = useMemo(() => {
    const m = new Map<number, LiveAircraft>();
    live?.aircraft.forEach((a) => m.set(a.flightId, a));
    return m;
  }, [live]);

  const phases = useMemo(() => {
    const s = new Set<string>();
    live?.aircraft.forEach((a) => s.add(a.phase));
    return ["All", ...Array.from(s).sort()];
  }, [live]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return flights
      .map((f) => ({ flight: f, pos: liveById.get(f.id) }))
      .filter(({ flight, pos }) => {
        if (phaseFilter !== "All" && pos?.phase !== phaseFilter) return false;
        if (!q) return true;
        return (
          flight.callsign.toLowerCase().includes(q) ||
          flight.player.toLowerCase().includes(q) ||
          flight.aircraft.toLowerCase().includes(q) ||
          (flight.dep_code ?? "").toLowerCase().includes(q) ||
          (flight.arr_code ?? "").toLowerCase().includes(q)
        );
      });
  }, [flights, liveById, query, phaseFilter]);

  const focus = (flightId: number) => {
    const a = liveById.get(flightId);
    if (!a || !mapRef.current) return;
    mapRef.current.setView(worldToLatLng(a.x, a.y), 6, { animate: true });
    setSelected(flightId);
  };

  const selectedAc = selected != null ? liveById.get(selected) : null;
  const selectedFlight = selected != null ? flights.find((f) => f.id === selected) : null;

  return (
    <div className="h-screen w-screen bg-[#05070d] text-slate-100 flex flex-col">
      <header className="border-b border-white/5 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">PFReplay Live · FR24-style</h1>
          <p className="text-[10px] text-slate-400">
            Tiles & data: pfreplay.com · polled every 3s
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            {live?.count ?? 0} live
          </span>
          <span>{flights.length} flights</span>
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 flex-shrink-0">
          {error}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative">
          <div ref={mapEl} className="absolute inset-0 bg-[#0a0f1a]" />
          {selectedAc && selectedFlight && (
            <div className="absolute top-2 right-2 z-[500] w-64 rounded-lg border border-white/10 bg-[#0a0f1a]/95 backdrop-blur p-3 text-xs shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-sm">{selectedFlight.callsign}</div>
                  <div className="text-slate-400">{selectedFlight.player}</div>
                </div>
                <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-slate-200">✕</button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-slate-300">
                <div><div className="text-slate-500">Aircraft</div>{selectedAc.aircraft}</div>
                <div><div className="text-slate-500">Phase</div>{selectedAc.phase}</div>
                <div><div className="text-slate-500">Alt</div>{selectedAc.altitude.toLocaleString()} ft</div>
                <div><div className="text-slate-500">Spd</div>{selectedAc.speed} kt</div>
                <div><div className="text-slate-500">Hdg</div>{selectedAc.heading}°</div>
                <div><div className="text-slate-500">Route</div>{selectedFlight.dep_code ?? "—"} → {selectedFlight.arr_code ?? "—"}</div>
              </div>
            </div>
          )}
        </div>

        <aside className="w-[340px] border-l border-white/5 bg-[#0a0f1a] flex flex-col min-h-0">
          <div className="p-2 flex gap-2 border-b border-white/5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-[#070a13] border border-white/10 rounded px-2 py-1 text-xs placeholder:text-slate-500 focus:outline-none focus:border-yellow-500"
            />
            <select
              value={phaseFilter}
              onChange={(e) => setPhaseFilter(e.target.value)}
              className="bg-[#070a13] border border-white/10 rounded px-1 py-1 text-xs"
            >
              {phases.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="px-2 py-1 text-[10px] text-slate-500 border-b border-white/5">{rows.length} shown</div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-[11px]">
              <tbody>
                {rows.map(({ flight, pos }) => (
                  <tr
                    key={flight.id}
                    onClick={() => focus(flight.id)}
                    className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${selected === flight.id ? "bg-yellow-500/10" : ""}`}
                  >
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-slate-100">{flight.callsign}</div>
                      <div className="text-slate-500">{flight.aircraft}</div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">
                      <div>{pos?.altitude.toLocaleString() ?? "—"}<span className="text-slate-500"> ft</span></div>
                      <div className="text-slate-500">{pos?.phase ?? "—"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </div>
  );
}
