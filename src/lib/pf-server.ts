import { createServerFn } from "@tanstack/react-start";
import type { LocationData, Plane, TouchdownData } from "./pf-proto";

// project-flight's own API (api.project-flight.com/v3/traffic/*) is currently
// returning 404 for everyone, including their official tracker. pfreplay mirrors
// the same PTFS traffic feed (and stores real recorded tracks), so we read from it.
const BASE = "https://pfreplay.com";

async function json<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; PFTracker/1.0)" },
  });
  if (!r.ok) throw new Error(`pfreplay ${path} ${r.status}`);
  return (await r.json()) as T;
}

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

export const fetchTraffic = createServerFn({ method: "GET" }).handler(async (): Promise<Plane[]> => {
  const d = await json<{ aircraft: LiveAircraft[] }>(`/api/live?cid=${Math.random().toString(36).slice(2)}`);
  return (d.aircraft ?? []).map((a) => ({
    server_id: String(a.serverId ?? "").replace(/[{}]/g, "").slice(0, 8),
    callsign: a.callsign ?? "",
    roblox_username: a.player ?? "",
    x: a.x,
    y: a.y,
    heading: a.heading ?? 0,
    altitude: a.altitude ?? 0,
    speed: a.speed ?? 0,
    model: a.aircraft ?? "",
    livery: a.livery ?? "",
    flight_id: a.flightId,
  }));
});

export const fetchUserTrail = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const o = d as { flightId?: unknown };
    const n = Number(o?.flightId);
    if (!Number.isFinite(n)) throw new Error("flightId required");
    return { flightId: n };
  })
  .handler(async ({ data }): Promise<{ locations: LocationData[]; touchdowns: TouchdownData[] }> => {
    const d = await json<{ track: { x: number; y: number; altitude: number; speed: number; t: number }[] }>(
      `/api/flights/${data.flightId}/track`,
    );
    const locations = (d.track ?? []).map((p) => ({
      x: p.x,
      y: p.y,
      altitude: p.altitude ?? 0,
      speed: p.speed ?? 0,
      ts: p.t,
    }));
    return { locations, touchdowns: [] };
  });
