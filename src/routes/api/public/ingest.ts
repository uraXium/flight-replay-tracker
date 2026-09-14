import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const AircraftSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  callsign: z.string().default(""),
  squawk: z.union([z.string(), z.number()]).transform(String).default("1200"),
  x: z.number(),
  y: z.number(),
  altitude: z.number().default(0),
  heading: z.number().default(0),
  speed: z.number().default(0),
  aircraft_type: z.string().optional(),
  player: z.string().optional(),
});

const PayloadSchema = z.object({
  source: z.string().optional(),
  bot_id: z.string().max(64).optional(),
  bot_label: z.string().max(64).optional(),
  server_job_id: z.string().default(""),
  timestamp: z.number().optional(),
  aircraft: z.array(AircraftSchema).max(2000),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const Route = createFileRoute("/api/public/ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token =
          request.headers.get("x-ingest-token") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          new URL(request.url).searchParams.get("token");
        const allowed = [process.env["PF_INGEST_TOKEN"], process.env["INGEST_TOKEN"]].filter(Boolean);
        if (!token || !allowed.includes(token)) return json({ error: "unauthorized" }, 401);

        let parsed;
        try {
          parsed = PayloadSchema.parse(await request.json());
        } catch (e) {
          return json({ error: "bad payload", details: String(e) }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const now = new Date().toISOString();
        const botId = parsed.bot_id || parsed.server_job_id || "bot-1";
        const rows = parsed.aircraft.map((a) => ({
          bot_id: botId,
          id: a.id,
          callsign: a.callsign,
          squawk: a.squawk,
          x: a.x,
          y: a.y,
          altitude: a.altitude,
          heading: a.heading,
          speed: a.speed,
          aircraft_type: a.aircraft_type ?? "",
          player: a.player ?? "",
          server_job_id: parsed.server_job_id,
          updated_at: now,
        }));

        if (rows.length) {
          const { error } = await supabaseAdmin.from("live_aircraft").upsert(rows, { onConflict: "id" });
          if (error) return json({ error: error.message }, 500);
        }

        // heartbeat for this bot
        await supabaseAdmin.from("ingest_bots").upsert(
          {
            bot_id: botId,
            label: parsed.bot_label ?? "",
            server_job_id: parsed.server_job_id,
            aircraft_count: rows.length,
            last_seen: now,
          },
          { onConflict: "bot_id" },
        );

        // drop aircraft that stopped reporting
        await supabaseAdmin
          .from("live_aircraft")
          .delete()
          .lt("updated_at", new Date(Date.now() - 60_000).toISOString());

        // drop bots that went offline for good
        await supabaseAdmin
          .from("ingest_bots")
          .delete()
          .lt("last_seen", new Date(Date.now() - 3_600_000).toISOString());

        return json({ ok: true, bot_id: botId, received: rows.length });
      },
      GET: async () => json({ ok: true, hint: "POST telemetry here with the x-ingest-token header" }),
    },
  },
});
