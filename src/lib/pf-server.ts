import { createServerFn } from "@tanstack/react-start";
import { decodeMultiPlanes } from "./pf-proto";
import type { Plane } from "./pf-proto";

// Live sources, in priority order.
// 1. Celesbit ATC scope backend — currently the only feed that is actually live.
//    GET https://celesbit.dev/api/v1/traffic/live/ -> { online, captured_at, nm_per_unit, aircraft[] }
//    Same world-unit grid (~0-400) as the Project Flight navdata (airports/fixes).
// 2. Official Project Flight tracker API (404 at the source right now).
// 3. ATC24 open mirror (different world scale, converted below).
const CELESBIT = "https://celesbit.dev/api/v1/traffic/live/";
const PF = "https://api.project-flight.com";
const ATC24 = "https://24data.ptfs.app";

const UA = "Mozilla/5.0 (compatible; PFTracker/1.0)";

export type TrafficSource = "own-scraper" | "celesbit" | "project-flight" | "atc24";
export type TrafficResult = { source: TrafficSource; planes: Plane[]; capturedAt?: string };

type CelesbitAcft = {
  callsign: string;
  aircraft_type: string;
  x: number;
  y: number;
  altitude_ft: number;
  groundspeed_kt: number;
  heading_deg: number;
  on_ground: boolean;
};

async function tryCelesbit(): Promise<{ planes: Plane[]; capturedAt?: string } | null> {
  try {
    const r = await fetch(CELESBIT, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (!r.ok) return null;
    const d = (await r.json()) as { online?: boolean; captured_at?: string; aircraft?: CelesbitAcft[] };
    const list = d.aircraft ?? [];
    if (!list.length) return null;
    return {
      capturedAt: d.captured_at,
      planes: list.map((a) => ({
        server_id: a.on_ground ? "GND" : "AIR",
        callsign: a.callsign ?? "",
        roblox_username: "",
        x: a.x,
        y: a.y,
        heading: a.heading_deg ?? 0,
        altitude: a.altitude_ft ?? 0,
        speed: a.groundspeed_kt ?? 0,
        model: a.aircraft_type ?? "",
        livery: "",
      })),
    };
  } catch {
    return null;
  }
}

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
    // official feed uses raw studs; scale into the navdata world grid
    return planes.length ? planes.map((p) => ({ ...p, x: p.x / 100, y: p.y / 100 })) : null;
  } catch {
    return null;
  }
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
    x: (a.position?.x ?? 0) / 100,
    y: (a.position?.y ?? 0) / 100,
    heading: a.heading ?? 0,
    altitude: a.altitude ?? 0,
    speed: a.speed ?? a.groundSpeed ?? 0,
    model: a.aircraftType ?? "",
    livery: a.wind ? `wind ${a.wind}` : "",
  }));
}

// Your own telemetry, posted by the Roblox scraper to /api/public/ingest.
async function tryOwnScraper(): Promise<Plane[] | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const since = new Date(Date.now() - 20_000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("live_aircraft")
      .select("id, callsign, squawk, x, y, altitude, heading, speed, aircraft_type, player")
      .gt("updated_at", since);
    if (error || !data || !data.length) return null;
    return data.map((a) => ({
      server_id: a.squawk ?? "",
      callsign: a.callsign || a.id,
      roblox_username: a.player ?? "",
      x: a.x,
      y: a.y,
      heading: a.heading ?? 0,
      altitude: a.altitude ?? 0,
      speed: a.speed ?? 0,
      model: a.aircraft_type ?? "",
      livery: "",
    }));
  } catch {
    return null;
  }
}

export const fetchTraffic = createServerFn({ method: "GET" }).handler(
  async (): Promise<TrafficResult> => {
    const own = await tryOwnScraper();
    if (own) return { source: "own-scraper", planes: own };
    const cb = await tryCelesbit();
    if (cb) return { source: "celesbit", planes: cb.planes, capturedAt: cb.capturedAt };
    const pf = await tryProjectFlight();
    if (pf) return { source: "project-flight", planes: pf };
    return { source: "atc24", planes: await tryAtc24() };
  },
);
