-- ============================================================
-- ProfixBook — invite links that work without email, and supplier
-- bank details.
--
-- Why: inviting a teammate depended on Supabase sending an email. When
-- that email didn't go out, the fallback message told the person to
-- "sign up" on the normal form, which asks for a company name and then
-- also needs an email confirmation that never arrives. The invitee
-- tried "Sign In" instead and got "Invalid login credentials".
--
-- New flow: the admin shares a join link (/join/<invite id>) on
-- WhatsApp. The page reads the invite through invite_details() below,
-- the invitee types their name and a password, and the accept-invite
-- Edge Function creates an already-confirmed account. handle_new_user()
-- (unchanged) attaches them to the business exactly as before.
--
-- The invite id is a random uuid that only that business's admins can
-- read (staff_invites RLS), so the link itself is the secret, the same
-- way a password-reset link is.
--
-- Run AFTER 0001-0052. Then deploy supabase/functions/accept-invite.
-- ============================================================

-- ------------------------------------------------------------
-- 1. What the join page may know about an invite: enough to say
--    "Join <company> as <role>", nothing else about the business.
-- ------------------------------------------------------------
create or replace function public.invite_details(p_invite uuid)
returns table (email text, role text, company text, status text)
language sql stable security definer set search_path = public as $$
  select i.email, i.role::text, t.name, i.status
    from staff_invites i
    join tenants t on t.id = i.tenant_id
   where i.id = p_invite;
$$;

revoke all on function public.invite_details(uuid) from public;
grant execute on function public.invite_details(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 2. For accept-invite only (service role): the invitee may already
--    have an auth account, e.g. they tried "Create Account" earlier and
--    never got the confirmation email. Decide what to do with it.
--
--    no_invite     the link is wrong or the invite was revoked
--    no_user       no account yet: the function creates one
--    attached      account existed with no business: joined it now
--    same_tenant   account already belongs to this business and has
--                  never signed in: the function sets their password
--    has_password  account already signed in before: send them to
--                  Sign In / Forgot password, never overwrite it
--    other_tenant  the email runs or works for another business
-- ------------------------------------------------------------
create or replace function public.invite_claim_existing(p_invite uuid)
returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_inv  record;
  v_user record;
  v_prof record;
begin
  select * into v_inv from staff_invites where id = p_invite;
  if not found then
    return jsonb_build_object('state', 'no_invite');
  end if;

  select id, last_sign_in_at into v_user
    from auth.users where lower(email) = lower(v_inv.email)
   limit 1;
  if not found then
    if v_inv.status <> 'pending' then
      return jsonb_build_object('state', 'no_invite');
    end if;
    return jsonb_build_object('state', 'no_user', 'email', v_inv.email);
  end if;

  select * into v_prof from profiles where id = v_user.id;

  if not found then
    if v_inv.status <> 'pending' then
      return jsonb_build_object('state', 'no_invite');
    end if;
    insert into profiles (id, tenant_id, branch_id, role, email)
    values (v_user.id, v_inv.tenant_id,
            coalesce(v_inv.branch_id, public.default_branch_id(v_inv.tenant_id)),
            v_inv.role, v_inv.email);
    update staff_invites set status = 'accepted' where id = v_inv.id;
    return jsonb_build_object('state', 'attached', 'user_id', v_user.id);
  end if;

  if v_prof.tenant_id <> v_inv.tenant_id then
    return jsonb_build_object('state', 'other_tenant');
  end if;

  if v_user.last_sign_in_at is not null then
    return jsonb_build_object('state', 'has_password');
  end if;

  update staff_invites set status = 'accepted' where id = v_inv.id and status = 'pending';
  return jsonb_build_object('state', 'same_tenant', 'user_id', v_user.id);
end;
$$;

revoke all on function public.invite_claim_existing(uuid) from public, anon, authenticated;
grant execute on function public.invite_claim_existing(uuid) to service_role;

-- ------------------------------------------------------------
-- 3. Where to send a supplier's money. Plain columns, readable and
--    writable under the suppliers table's existing policies.
-- ------------------------------------------------------------
alter table suppliers add column if not exists bank_name text;
alter table suppliers add column if not exists account_name text;
alter table suppliers add column if not exists account_number text;
