import { createServerFn } from "@tanstack/react-start";
import type { Plane } from "./pf-proto";

// pfreplay.com is offline (whole site returns 404) and api.project-flight.com
// no longer serves /v3/traffic/*. The ATC24 open data feed mirrors the same
// PTFS live traffic and is currently the only working public source.
const BASE = "https://24data.ptfs.app";

async function json<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; PFTracker/1.0)" },
  });
  if (!r.ok) throw new Error(`24data ${path} ${r.status}`);
  return (await r.json()) as T;
}

type Acft = {
  playerName: string;
  heading: number;
  altitude: number;
  speed: number;
  groundSpeed: number;
  aircraftType: string;
  isOnGround: boolean;
  isEmergencyOccuring: boolean;
  wind: string;
  position: { x: number; y: number };
};

export const fetchTraffic = createServerFn({ method: "GET" }).handler(async (): Promise<Plane[]> => {
  const d = await json<Record<string, Acft>>("/acft-data");
  return Object.entries(d ?? {}).map(([callsign, a]) => ({
    server_id: a.isEmergencyOccuring ? "EMERG" : "",
    callsign,
    roblox_username: a.playerName ?? "",
    x: a.position?.x ?? 0,
    y: a.position?.y ?? 0,
    heading: a.heading ?? 0,
    altitude: a.altitude ?? 0,
    speed: a.speed ?? a.groundSpeed ?? 0,
    model: a.aircraftType ?? "",
    livery: a.wind ? `wind ${a.wind}` : "",
  }));
});

export type Controller = {
  holder: string;
  airport: string;
  position: string;
  heldSince: number;
  queue: string[];
};

export const fetchControllers = createServerFn({ method: "GET" }).handler(
  async (): Promise<Controller[]> => {
    const d = await json<Controller[]>("/controllers");
    return Array.isArray(d) ? d : [];
  },
);
