-- ============================================================
-- Pro code generation helpers
-- ============================================================
-- Wraps the bulk INSERT in a function so generating codes is just:
--   SELECT * FROM public.generate_pro_codes(10, 30, 'M');
-- or for mixed batches:
--   SELECT * FROM public.generate_pro_codes_multi('[...]'::jsonb);
--
-- Security: SECURITY DEFINER + restricted grants. Only service_role
-- (and the SQL Editor's postgres superuser) can execute. End users on
-- the app cannot self-grant codes.
-- ============================================================

-- ── 1. Single duration, batch count ─────────────────────────────
-- p_count          : how many codes to mint (1..1000)
-- p_duration_days  : Pro duration this code grants (e.g. 30 / 90 / 365)
-- p_tag            : short label in the code, uppercase alnum, 1..8 chars
--                    (e.g. 'M' / 'Q' / 'Y' / 'WECHAT' / 'PROMO')
-- p_validity       : how long the *code itself* stays redeemable
--                    (independent of the Pro duration it grants)
create or replace function public.generate_pro_codes(
  p_count          int,
  p_duration_days  int,
  p_tag            text     default 'M',
  p_validity       interval default '1 year'
) returns table (
  code           text,
  duration_days  int,
  expires_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text := 'NATIVEOS';
begin
  if p_count is null or p_count <= 0 or p_count > 1000 then
    raise exception 'generate_pro_codes: count must be between 1 and 1000, got %', p_count;
  end if;
  if p_duration_days is null or p_duration_days <= 0 then
    raise exception 'generate_pro_codes: duration_days must be positive, got %', p_duration_days;
  end if;
  if p_tag is null or p_tag !~ '^[A-Z0-9]{1,8}$' then
    raise exception 'generate_pro_codes: tag must be 1-8 uppercase alphanumeric chars, got %', p_tag;
  end if;

  return query
  with inserted as (
    insert into public.pro_codes (code, duration_days, expires_at)
    select
      v_prefix || '-' || upper(p_tag) || '-' ||
        lpad(i::text, 2, '0') || '-' ||
        upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 6)),
      p_duration_days,
      now() + p_validity
    from generate_series(1, p_count) as i
    returning pro_codes.code, pro_codes.duration_days, pro_codes.expires_at
  )
  select i.code, i.duration_days, i.expires_at
  from inserted i
  order by i.code;
end;
$$;

-- ── 2. Mixed batch via jsonb spec ───────────────────────────────
-- p_specs : JSON array of {count, duration_days, tag, validity?}
--           e.g. '[
--             {"count": 5, "duration_days": 30,  "tag": "M"},
--             {"count": 3, "duration_days": 90,  "tag": "Q"},
--             {"count": 2, "duration_days": 365, "tag": "Y", "validity": "6 months"}
--           ]'::jsonb
create or replace function public.generate_pro_codes_multi(
  p_specs jsonb
) returns table (
  code           text,
  duration_days  int,
  expires_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_specs is null or jsonb_typeof(p_specs) <> 'array' then
    raise exception 'generate_pro_codes_multi: specs must be a JSON array';
  end if;
  if jsonb_array_length(p_specs) = 0 then
    raise exception 'generate_pro_codes_multi: specs must not be empty';
  end if;
  if jsonb_array_length(p_specs) > 20 then
    raise exception 'generate_pro_codes_multi: specs must have at most 20 entries';
  end if;

  return query
  with parsed as (
    select
      (s->>'count')::int                                        as n,
      (s->>'duration_days')::int                                as duration_days,
      upper(coalesce(s->>'tag', 'M'))                           as tag,
      coalesce((s->>'validity')::interval, '1 year'::interval)  as validity
    from jsonb_array_elements(p_specs) s
  ),
  inserted as (
    insert into public.pro_codes (code, duration_days, expires_at)
    select
      'NATIVEOS-' || p.tag || '-' ||
        lpad(i::text, 2, '0') || '-' ||
        upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 6)),
      p.duration_days,
      now() + p.validity
    from parsed p, generate_series(1, p.n) as i
    where p.n > 0 and p.n <= 1000
      and p.duration_days > 0
    returning pro_codes.code, pro_codes.duration_days, pro_codes.expires_at
  )
  select i.code, i.duration_days, i.expires_at
  from inserted i
  order by i.duration_days desc, i.code;
end;
$$;

-- ── Permissions ───────────────────────────────────────────────
-- SECURITY DEFINER runs as the function owner (postgres in SQL Editor).
-- End users on the app cannot call these via PostgREST — they hit
-- the grant-revoked path. Only service_role + superuser can execute.

revoke execute on function public.generate_pro_codes(int, int, text, interval) from public;
revoke execute on function public.generate_pro_codes(int, int, text, interval) from anon;
revoke execute on function public.generate_pro_codes(int, int, text, interval) from authenticated;

revoke execute on function public.generate_pro_codes_multi(jsonb) from public;
revoke execute on function public.generate_pro_codes_multi(jsonb) from anon;
revoke execute on function public.generate_pro_codes_multi(jsonb) from authenticated;

-- service_role can call from server-side code; the SQL Editor runs as
-- postgres (superuser) so it doesn't need a grant.
grant execute on function public.generate_pro_codes(int, int, text, interval) to service_role;
grant execute on function public.generate_pro_codes_multi(jsonb) to service_role;
