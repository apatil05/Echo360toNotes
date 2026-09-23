-- Projects created with "Enable automatic RLS" get public.rls_auto_enable(),
-- an event-trigger function that Supabase leaves executable by anon and
-- authenticated through the Data API. The event trigger doesn't need those
-- grants, so remove them (flagged by the security advisor).
-- Local stacks don't have the function, hence the existence check.

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
