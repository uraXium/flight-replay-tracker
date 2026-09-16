import { createServerFn } from "@tanstack/react-start";
import { decodeMultiPlanes } from "./pf-proto";
import type { Plane } from "./pf-proto";

// Project Flight only.
// 1. Your own bots (Roblox clients posting to /api/public/ingest).
// 2. The official Project Flight tracker API, when it comes back up.
const PF = "https://api.project-flight.com";
const UA = "Mozilla/5.0 (compatible; PFTracker/1.0)";

export type TrafficSource = "own-scraper" | "project-flight" | "none";
export type TrafficResult = { source: TrafficSource; planes: Plane[]; capturedAt?: string };

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

export type BotStatus = {
  bot_id: string;
  label: string;
  server_job_id: string;
  aircraft_count: number;
  last_seen: string;
  online: boolean;
};

// Status of every bot that has reported in recently.
export const fetchBots = createServerFn({ method: "GET" }).handler(async (): Promise<BotStatus[]> => {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("ingest_bots")
      .select("bot_id, label, server_job_id, aircraft_count, last_seen")
      .order("last_seen", { ascending: false });
    if (error || !data) return [];
    const cutoff = Date.now() - 30_000;
    return data.map((b) => ({
      bot_id: b.bot_id,
      label: b.label ?? "",
      server_job_id: b.server_job_id ?? "",
      aircraft_count: b.aircraft_count ?? 0,
      last_seen: b.last_seen,
      online: new Date(b.last_seen).getTime() > cutoff,
    }));
  } catch {
    return [];
  }
});

export const fetchTraffic = createServerFn({ method: "GET" }).handler(
  async (): Promise<TrafficResult> => {
    const own = await tryOwnScraper();
    if (own) return { source: "own-scraper", planes: own };
    const pf = await tryProjectFlight();
    if (pf) return { source: "project-flight", planes: pf };
    return { source: "none", planes: [] };
  },
);
