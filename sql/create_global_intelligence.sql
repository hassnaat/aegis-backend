create table if not exists public.global_intelligence (
  news_id text primary key,
  title text,
  summary text,
  source_url text,
  source text,
  lat double precision,
  lon double precision,
  location_text text,
  confidence_score double precision,
  verified boolean,
  matched_hotspot_lat double precision,
  matched_hotspot_lon double precision,
  matched_hotspot_date text,
  matched_hotspot_time text,
  matched_hotspot_confidence text,
  distance_km double precision,
  model text,
  timestamp timestamptz default now(),
  type text
);

alter table if exists public.global_intelligence enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'global_intelligence'
      and policyname = 'public read global_intelligence'
  ) then
    execute $sql$
      create policy "public read global_intelligence"
        on public.global_intelligence
        for select
        using (true);
    $sql$;
  end if;
end $$;
