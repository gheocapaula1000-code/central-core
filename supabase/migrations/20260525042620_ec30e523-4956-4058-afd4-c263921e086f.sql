create table if not exists public.luxu_assets (
  id text primary key,
  title text not null,
  category text not null,
  country text default 'IT',
  region text,
  city text,
  price_eur numeric,
  price_min_eur numeric,
  price_max_eur numeric,
  price_confidence text default 'unknown',
  surface_sqm numeric,
  score integer not null default 0,
  priority text not null default 'low',
  why_now text,
  opportunity text,
  risk text,
  source_category text not null,
  source_label text not null,
  source_url text,
  hero_image_url text,
  extraction_confidence text default 'medium',
  location_confidence text default 'inferred',
  missing_fields text[] default '{}',
  dossier_available boolean default false,
  convergent_signal boolean default false,
  merge_count integer default 1,
  merged_sources jsonb default '[]',
  times_seen integer default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_scan_run_id text,
  active boolean default true
);

create index if not exists luxu_assets_score_idx on public.luxu_assets(score desc);
create index if not exists luxu_assets_priority_idx on public.luxu_assets(priority);
create index if not exists luxu_assets_category_idx on public.luxu_assets(category);
create index if not exists luxu_assets_region_idx on public.luxu_assets(region);
create index if not exists luxu_assets_last_seen_idx on public.luxu_assets(last_seen_at desc);
create index if not exists luxu_assets_convergent_idx on public.luxu_assets(convergent_signal);
create index if not exists luxu_assets_active_idx on public.luxu_assets(active);

alter table public.luxu_assets enable row level security;

create policy "anon can read active assets"
  on public.luxu_assets for select
  using (active = true);

create policy "service role can do anything"
  on public.luxu_assets for all
  using (auth.role() = 'service_role');