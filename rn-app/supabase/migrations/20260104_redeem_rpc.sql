-- ============================================================
-- Atomic Pro code redemption via RPC
-- ============================================================
-- Replaces the brittle client-side flow that was failing because
-- the pro_codes SELECT RLS policy hid unused rows from the probe.
-- The RPC runs as SECURITY DEFINER, so it can read/update the
-- table without depending on RLS, but it does the validation
-- itself (auth.uid, expiry, used_by, etc.).
--
-- One row returned, columns:
--   ok               true on success
--   duration_days    new Pro duration granted
--   new_expires_at   resulting pro_expires_at on profiles
--   reason           null on success; otherwise one of:
--                     'not_signed_in' | 'invalid' | 'used' | 'expired'
-- ============================================================

create or replace function public.redeem_pro_code(code_text text)
returns table (
  ok              boolean,
  duration_days   int,
  new_expires_at  timestamptz,
  reason          text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid              uuid := auth.uid();
  v_code             record;
  v_current_expires  timestamptz;
  v_base_ms          bigint;
  v_new_expires      timestamptz;
  v_normalized       text;
begin
  if v_uid is null then
    ok := false; duration_days := 0; new_expires_at := null;
    reason := 'not_signed_in';
    return next; return;
  end if;

  v_normalized := upper(trim(coalesce(code_text, '')));
  if v_normalized = '' then
    ok := false; duration_days := 0; new_expires_at := null;
    reason := 'invalid';
    return next; return;
  end if;

  -- Lock the row first to prevent two concurrent redeemers from
  -- both passing the "used_by is null" check.
  select * into v_code
  from public.pro_codes
  where code = v_normalized
  for update;

  if not found then
    ok := false; duration_days := 0; new_expires_at := null;
    reason := 'invalid';
    return next; return;
  end if;

  if v_code.used_by is not null then
    ok := false; duration_days := 0; new_expires_at := null;
    reason := 'used';
    return next; return;
  end if;

  if v_code.expires_at <= now() then
    ok := false; duration_days := 0; new_expires_at := null;
    reason := 'expired';
    return next; return;
  end if;

  -- Compute new expiry: extend from max(current, now()) if still Pro,
  -- otherwise from now.
  select p.pro_expires_at into v_current_expires
  from public.profiles p
  where p.id = v_uid;

  v_base_ms := greatest(
    extract(epoch from coalesce(v_current_expires, now()))::bigint,
    extract(epoch from now())::bigint
  );

  v_new_expires := to_timestamp(v_base_ms + v_code.duration_days * 86400);

  -- Mark the code as used.
  update public.pro_codes
  set used_by = v_uid, used_at = now()
  where code = v_code.code;

  -- Update profile Pro state.
  update public.profiles
  set is_pro          = true,
      pro_expires_at  = v_new_expires,
      updated_at      = now()
  where id = v_uid;

  ok := true;
  duration_days := v_code.duration_days;
  new_expires_at := v_new_expires;
  reason := null;
  return next;
end;
$$;

-- Allow signed-in users to call the RPC. The function itself enforces
-- auth.uid(); this grant only enables the call path.
grant execute on function public.redeem_pro_code(text) to authenticated;

-- The previous direct-UPDATE flow is no longer needed at the app
-- level. We can leave the existing pro_codes_redeem policy in place
-- as defence-in-depth (it still blocks direct table UPDATE outside
-- this RPC), or drop it. Keeping it for now.
