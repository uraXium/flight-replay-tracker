CREATE TABLE public.ingest_bots (
  bot_id text PRIMARY KEY,
  label text NOT NULL DEFAULT '',
  server_job_id text NOT NULL DEFAULT '',
  aircraft_count integer NOT NULL DEFAULT 0,
  last_seen timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ingest_bots TO anon, authenticated;
GRANT ALL ON public.ingest_bots TO service_role;

ALTER TABLE public.ingest_bots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Bot status is publicly readable"
  ON public.ingest_bots FOR SELECT
  TO anon, authenticated
  USING (true);

ALTER TABLE public.live_aircraft ADD COLUMN IF NOT EXISTS bot_id text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS ingest_bots_last_seen_idx ON public.ingest_bots (last_seen DESC);