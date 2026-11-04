create policy "Allow active agencies to check their own status"
on public.agency_access_grants
for select
using (email = auth.jwt()->>'email' and is_active = true);
