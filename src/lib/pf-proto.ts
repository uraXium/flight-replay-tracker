// Minimal proto3 decoder for project-flight's trackerdata messages.
// Schemas reverse-engineered from tracker.project-flight.com bundle.

export type Plane = {
  server_id: string;
  callsign: string;
  roblox_username: string;
  x: number; y: number;
  heading: number;
  altitude: number;
  speed: number;
  model: string;
  livery: string;
};
export type LocationData = { x: number; y: number; altitude: number; speed: number; ts?: number };
export type TouchdownData = { x: number; y: number; airport: string; runway: string; fpm: number; ts?: number };
export type UserPlaneData = { plane: Plane | null; locations: LocationData[]; touchdowns: TouchdownData[] };

function readVarint(b: Uint8Array, i: number): [number, number] {
  let r = 0, s = 0, x = 0;
  for (;;) {
    x = b[i++]; r |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [r, i];
    s += 7;
    if (s > 63) return [r, i];
  }
}

type Field =
  | { name: string; kind: "string" | "double" | "int32" | "skip" }
  | { name: string; kind: "msg"; T: FieldMap; repeated?: boolean };
type FieldMap = Record<number, Field>;

function decode(buf: Uint8Array, map: FieldMap): any {
  const out: any = {};
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i < buf.length) {
    const [tag, ni] = readVarint(buf, i); i = ni;
    const fno = tag >>> 3, wt = tag & 7;
    const f = map[fno];
    let v: any;
    if (wt === 0) { const [x, ni2] = readVarint(buf, i); v = x; i = ni2; }
    else if (wt === 1) { v = dv.getFloat64(i, true); i += 8; }
    else if (wt === 2) { const [ln, ni2] = readVarint(buf, i); i = ni2; const sl = buf.subarray(i, i + ln); i += ln;
      if (!f) { continue; }
      if (f.kind === "string") v = new TextDecoder().decode(sl);
      else if (f.kind === "msg") v = decode(sl, f.T);
      else v = sl;
    }
    else if (wt === 5) { v = dv.getFloat32(i, true); i += 4; }
    else return out;
    if (!f) continue;
    if (f.kind === "msg" && f.repeated) { (out[f.name] ||= []).push(v); }
    else out[f.name] = v;
  }
  return out;
}

const PLANE: FieldMap = {
  1: { name: "server_id", kind: "string" },
  2: { name: "callsign", kind: "string" },
  3: { name: "roblox_username", kind: "string" },
  4: { name: "x", kind: "double" },
  5: { name: "y", kind: "double" },
  6: { name: "heading", kind: "double" },
  7: { name: "altitude", kind: "double" },
  8: { name: "speed", kind: "double" },
  9: { name: "model", kind: "string" },
  10: { name: "livery", kind: "string" },
};
const LOC: FieldMap = {
  1: { name: "x", kind: "double" },
  2: { name: "y", kind: "double" },
  3: { name: "altitude", kind: "double" },
  4: { name: "speed", kind: "double" },
};
const TOUCH: FieldMap = {
  1: { name: "x", kind: "double" },
  2: { name: "y", kind: "double" },
  3: { name: "airport", kind: "string" },
  4: { name: "runway", kind: "string" },
  5: { name: "fpm", kind: "double" },
};
const USER_PLANE: FieldMap = {
  1: { name: "plane", kind: "msg", T: PLANE },
  2: { name: "locations", kind: "msg", T: LOC, repeated: true },
  3: { name: "touchdowns", kind: "msg", T: TOUCH, repeated: true },
};

// MultiPlanes = repeated Plane at field 1
export function decodeMultiPlanes(bytes: Uint8Array): Plane[] {
  const planes: Plane[] = [];
  let i = 0;
  while (i < bytes.length) {
    const [tag, ni] = readVarint(bytes, i); i = ni;
    const wt = tag & 7; const fno = tag >>> 3;
    if (wt !== 2) return planes;
    const [ln, ni2] = readVarint(bytes, i); i = ni2;
    const sl = bytes.subarray(i, i + ln); i += ln;
    if (fno === 1) planes.push(decode(sl, PLANE) as Plane);
  }
  return planes;
}

export function decodeUserPlane(bytes: Uint8Array): UserPlaneData {
  const r = decode(bytes, USER_PLANE);
  return { plane: r.plane ?? null, locations: r.locations ?? [], touchdowns: r.touchdowns ?? [] };
}
