-- Browser demo call recordings (the voice agent uploads them with the service key to
-- call-recordings/<clerk user id>/<uuid>.wav). The bucket is private; each user can only
-- read files in their own folder. Clerk third-party auth: the user id is auth.jwt() ->> 'sub'.
INSERT INTO storage.buckets (id, name, public) VALUES ('call-recordings', 'call-recordings', false)
  ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "Users can play own call recordings" ON storage.objects;
CREATE POLICY "Users can play own call recordings" ON storage.objects FOR SELECT
  USING (bucket_id = 'call-recordings' AND (auth.jwt() ->> 'sub') = (storage.foldername(name))[1]);
