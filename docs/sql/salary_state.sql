-- Автоматично записване на калкулатора за заплати (S37). Пуска се ВЕДНЪЖ в Supabase → SQL Editor
-- (проект ptzgxreojfvdltbavlop = „motamo-competitor-watch“). Таблиците са затворени за anon; достъпът е през
-- SECURITY DEFINER функции с таен ключ, който сървърът извежда от PEEK_TOKEN (първото извикване го записва в sal_cfg).
create table if not exists public.sal_state (
  key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.sal_cfg (
  id int primary key default 1 check (id = 1),
  secret text not null
);
alter table public.sal_state enable row level security;
alter table public.sal_cfg enable row level security;

create or replace function public.sal_init(p_secret text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_secret is null or length(p_secret) < 16 then return false; end if;
  insert into sal_cfg(id, secret) values (1, p_secret) on conflict (id) do nothing;
  return exists (select 1 from sal_cfg where secret = p_secret);
end $$;

create or replace function public.sal_get_all(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from sal_cfg where secret = p_secret) then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_object_agg(key, jsonb_build_object('payload', payload, 'updated_at', updated_at)) from sal_state), '{}'::jsonb);
end $$;

create or replace function public.sal_put(p_secret text, p_key text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from sal_cfg where secret = p_secret) then raise exception 'forbidden'; end if;
  insert into sal_state(key, payload, updated_at) values (p_key, p_payload, now())
  on conflict (key) do update set payload = excluded.payload, updated_at = now();
end $$;

revoke all on function public.sal_init(text), public.sal_get_all(text), public.sal_put(text, text, jsonb) from public;
grant execute on function public.sal_init(text), public.sal_get_all(text), public.sal_put(text, text, jsonb) to anon;
