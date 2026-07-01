import { createServerFn } from "@tanstack/react-start";
import { decodeMultiPlanes, decodeUserPlane, type Plane, type UserPlaneData } from "./pf-proto";

const ORIGIN = "https://tracker.project-flight.com";
const HDRS = {
  Origin: ORIGIN,
  Referer: ORIGIN + "/",
  "User-Agent": "Mozilla/5.0 (compatible; PFTracker/1.0)",
};

async function pf(path: string): Promise<Uint8Array> {
  const r = await fetch(`https://api.project-flight.com${path}`, { headers: HDRS });
  if (!r.ok) throw new Error(`PF ${path} ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return buf;
}

export const fetchTraffic = createServerFn({ method: "GET" }).handler(async (): Promise<Plane[]> => {
  const buf = await pf("/v3/traffic/fetch");
  return decodeMultiPlanes(buf);
});

export const fetchUserTrail = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const o = d as { username?: unknown };
    if (!o || typeof o.username !== "string") throw new Error("username required");
    return { username: o.username };
  })
  .handler(async ({ data }): Promise<UserPlaneData> => {
    const buf = await pf(`/v3/traffic/fetch/${encodeURIComponent(data.username)}`);
    return decodeUserPlane(buf);
  });

