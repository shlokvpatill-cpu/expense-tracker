-- N.D. Patil Canteen – cloud sync setup.
-- Paste all of this into Supabase → SQL Editor → New query, and press Run. Safe to run again.

-- one row per entry (expense, payment, one day's sales, …)
create table if not exists public.canteen_records (
  kind       text        not null,
  key        text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (kind, key)
);
create index if not exists canteen_records_updated_at on public.canteen_records (updated_at);

-- the server stamps every change, so devices with a wrong clock still sync correctly
create or replace function public.canteen_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists canteen_touch on public.canteen_records;
create trigger canteen_touch before insert or update on public.canteen_records
  for each row execute function public.canteen_touch();

-- only signed-in users (the accounts you add yourself) can read or write
alter table public.canteen_records enable row level security;
grant select, insert, update on public.canteen_records to authenticated;
revoke all on public.canteen_records from anon;
drop policy if exists "canteen read" on public.canteen_records;
drop policy if exists "canteen add" on public.canteen_records;
drop policy if exists "canteen change" on public.canteen_records;
create policy "canteen read"   on public.canteen_records for select to authenticated using (true);
create policy "canteen add"    on public.canteen_records for insert to authenticated with check (true);
create policy "canteen change" on public.canteen_records for update to authenticated using (true) with check (true);

-- private folder for bill photos and PDFs
insert into storage.buckets (id, name, public) values ('bills', 'bills', false) on conflict (id) do nothing;
drop policy if exists "bills read" on storage.objects;
drop policy if exists "bills add" on storage.objects;
drop policy if exists "bills change" on storage.objects;
drop policy if exists "bills delete" on storage.objects;
create policy "bills read"   on storage.objects for select to authenticated using (bucket_id = 'bills');
create policy "bills add"    on storage.objects for insert to authenticated with check (bucket_id = 'bills');
create policy "bills change" on storage.objects for update to authenticated using (bucket_id = 'bills') with check (bucket_id = 'bills');
create policy "bills delete" on storage.objects for delete to authenticated using (bucket_id = 'bills');
