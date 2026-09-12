import { createServerFn } from "@tanstack/react-start";
import { decodeMultiPlanes, decodeUserPlane } from "./pf-proto";
import type { LocationData, Plane, TouchdownData } from "./pf-proto";

// Primary source: the official Project Flight tracker API.
// It is currently returning 404 for everyone (their own tracker included), so
// we fall back to pfreplay, then to the ATC24 mirror, and report which one is live.
const PF = "https://api.project-flight.com";
const PFREPLAY = "https://pfreplay.com";
const ATC24 = "https://24data.ptfs.app";

const UA = "Mozilla/5.0 (compatible; PFTracker/1.0)";

export type TrafficResult = { source: "project-flight" | "pfreplay" | "atc24"; planes: Plane[] };

async function tryProjectFlight(): Promise<Plane[] | null> {
  try {
    const r = await fetch(`${PF}/v3/traffic/fetch`, {
      headers: {
        Accept: "application/x-protobuf, application/octet-stream, */*",
        Origin: "https://tracker.project-flight.com",
        Referer: "https://tracker.project-flight.com/",
        "User-Agent": UA,
      },
    });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength === 0) return null;
    const planes = decodeMultiPlanes(buf);
    return planes.length ? planes : null;
  } catch {
    return null;
  }
}

type LiveAircraft = {
  callsign: string; player: string; serverId: string;
  x: number; y: number; heading: number; altitude: number; speed: number;
  aircraft: string; livery: string; flightId: number;
};

async function tryPfReplay(): Promise<Plane[] | null> {
  try {
    const r = await fetch(`${PFREPLAY}/api/live?cid=${Math.random().toString(36).slice(2)}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { aircraft?: LiveAircraft[] };
    const list = d.aircraft ?? [];
    if (!list.length) return null;
    return list.map((a) => ({
      server_id: String(a.serverId ?? "").replace(/[{}]/g, "").slice(0, 8),
      callsign: a.callsign ?? "",
      roblox_username: a.player ?? "",
      x: a.x, y: a.y,
      heading: a.heading ?? 0,
      altitude: a.altitude ?? 0,
      speed: a.speed ?? 0,
      model: a.aircraft ?? "",
      livery: a.livery ?? "",
      flight_id: a.flightId,
    }));
  } catch {
    return null;
  }
}

type Acft = {
  playerName: string; heading: number; altitude: number; speed: number; groundSpeed: number;
  aircraftType: string; isOnGround: boolean; isEmergencyOccuring: boolean; wind: string;
  position: { x: number; y: number };
};

async function tryAtc24(): Promise<Plane[]> {
  const r = await fetch(`${ATC24}/acft-data`, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!r.ok) throw new Error(`no live source available (atc24 ${r.status})`);
  const d = (await r.json()) as Record<string, Acft>;
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
}

export const fetchTraffic = createServerFn({ method: "GET" }).handler(
  async (): Promise<TrafficResult> => {
    const pf = await tryProjectFlight();
    if (pf) return { source: "project-flight", planes: pf };
    const pr = await tryPfReplay();
    if (pr) return { source: "pfreplay", planes: pr };
    return { source: "atc24", planes: await tryAtc24() };
  },
);

// Official trail endpoint, used when Project Flight is reachable.
export const fetchUserTrail = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const u = (d as { username?: unknown })?.username;
    if (typeof u !== "string" || !u) throw new Error("username required");
    return { username: u };
  })
  .handler(async ({ data }): Promise<{ locations: LocationData[]; touchdowns: TouchdownData[] }> => {
    try {
      const r = await fetch(`${PF}/v3/traffic/fetch/${encodeURIComponent(data.username)}`, {
        headers: {
          Accept: "application/x-protobuf, application/octet-stream, */*",
          Origin: "https://tracker.project-flight.com",
          Referer: "https://tracker.project-flight.com/",
          "User-Agent": UA,
        },
      });
      if (!r.ok) return { locations: [], touchdowns: [] };
      const up = decodeUserPlane(new Uint8Array(await r.arrayBuffer()));
      return { locations: up.locations ?? [], touchdowns: up.touchdowns ?? [] };
    } catch {
      return { locations: [], touchdowns: [] };
    }
  });
