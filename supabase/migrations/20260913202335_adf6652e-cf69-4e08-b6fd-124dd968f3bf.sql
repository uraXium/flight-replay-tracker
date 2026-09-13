CREATE TABLE public.live_aircraft (
  id text PRIMARY KEY,
  callsign text NOT NULL DEFAULT '',
  squawk text NOT NULL DEFAULT '1200',
  x double precision NOT NULL DEFAULT 0,
  y double precision NOT NULL DEFAULT 0,
  altitude double precision NOT NULL DEFAULT 0,
  heading double precision NOT NULL DEFAULT 0,
  speed double precision NOT NULL DEFAULT 0,
  aircraft_type text NOT NULL DEFAULT '',
  player text NOT NULL DEFAULT '',
  server_job_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX live_aircraft_updated_at_idx ON public.live_aircraft (updated_at DESC);

GRANT SELECT ON public.live_aircraft TO anon;
GRANT SELECT ON public.live_aircraft TO authenticated;
GRANT ALL ON public.live_aircraft TO service_role;

ALTER TABLE public.live_aircraft ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Live traffic is publicly readable"
  ON public.live_aircraft FOR SELECT
  TO anon, authenticated
  USING (true);