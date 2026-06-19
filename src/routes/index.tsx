import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

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

function randomCid() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

function Index() {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<string>("All");
  const cid = useMemo(randomCid, []);

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

  const bounds = useMemo(() => {
    if (!live?.aircraft.length) return { minX: -100000, maxX: 100000, minY: -100000, maxY: 100000 };
    const xs = live.aircraft.map((a) => a.x);
    const ys = live.aircraft.map((a) => a.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, [live]);

  return (
    <div className="min-h-screen bg-[#05070d] text-slate-100">
      <header className="border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">PFReplay Live Flights</h1>
          <p className="text-xs text-slate-400">
            Real-time data from pfreplay.com · polled every 3s
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            {live?.count ?? 0} aircraft live
          </span>
          <span>{flights.length} active flights</span>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4 p-4">
        <div className="rounded-lg border border-white/5 bg-[#0a0f1a] p-3">
          <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">
            Position map (PFReplay world coordinates)
          </div>
          <svg viewBox="0 0 800 500" className="w-full h-[520px]">
            <rect width="800" height="500" fill="#070a13" />
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`v${i}`} x1={(i * 800) / 8} y1={0} x2={(i * 800) / 8} y2={500} stroke="#121a2b" />
            ))}
            {Array.from({ length: 6 }).map((_, i) => (
              <line key={`h${i}`} x1={0} y1={(i * 500) / 5} x2={800} y2={(i * 500) / 5} stroke="#121a2b" />
            ))}
            {live?.aircraft.map((a) => {
              const rangeX = Math.max(1, bounds.maxX - bounds.minX);
              const rangeY = Math.max(1, bounds.maxY - bounds.minY);
              const px = ((a.x - bounds.minX) / rangeX) * 780 + 10;
              const py = 500 - (((a.y - bounds.minY) / rangeY) * 480 + 10);
              const color =
                a.phase === "Cruise"
                  ? "#38bdf8"
                  : a.phase === "Climbing"
                    ? "#34d399"
                    : a.phase === "Descending"
                      ? "#fbbf24"
                      : a.phase === "Taxiing"
                        ? "#94a3b8"
                        : "#a78bfa";
              return (
                <g key={a.flightId} transform={`translate(${px} ${py}) rotate(${a.heading})`}>
                  <polygon points="0,-5 4,5 0,3 -4,5" fill={color} />
                </g>
              );
            })}
          </svg>
        </div>

        <div className="rounded-lg border border-white/5 bg-[#0a0f1a] p-3 flex flex-col min-h-[520px]">
          <div className="flex gap-2 mb-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search callsign, player, airport…"
              className="flex-1 bg-[#070a13] border border-white/10 rounded px-2 py-1.5 text-sm placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
            <select
              value={phaseFilter}
              onChange={(e) => setPhaseFilter(e.target.value)}
              className="bg-[#070a13] border border-white/10 rounded px-2 py-1.5 text-sm"
            >
              {phases.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="text-xs text-slate-400 mb-2">{rows.length} shown</div>
          <div className="flex-1 overflow-auto -mx-3">
            <table className="w-full text-xs">
              <thead className="text-slate-400 sticky top-0 bg-[#0a0f1a]">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Callsign</th>
                  <th className="px-3 py-2 font-medium">Aircraft</th>
                  <th className="px-3 py-2 font-medium">Route</th>
                  <th className="px-3 py-2 font-medium text-right">Alt</th>
                  <th className="px-3 py-2 font-medium text-right">Spd</th>
                  <th className="px-3 py-2 font-medium">Phase</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ flight, pos }) => (
                  <tr key={flight.id} className="border-t border-white/5 hover:bg-white/5">
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{flight.callsign}</div>
                      <div className="text-slate-500">{flight.player}</div>
                    </td>
                    <td className="px-3 py-1.5 text-slate-300">{flight.aircraft}</td>
                    <td className="px-3 py-1.5 text-slate-300">
                      {flight.dep_code ?? "—"} → {flight.arr_code ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{pos?.altitude.toLocaleString() ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{pos?.speed ?? "—"}</td>
                    <td className="px-3 py-1.5 text-slate-400">{pos?.phase ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
