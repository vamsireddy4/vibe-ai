CREATE TABLE public.appointment_bookings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  appointment_tool_id UUID REFERENCES public.appointment_tools(id) ON DELETE SET NULL,
  calendar_integration_id UUID REFERENCES public.calendar_integrations(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  calendar_name TEXT,
  provider_booking_id TEXT,
  title TEXT,
  booked_for_name TEXT NOT NULL,
  booked_for_email TEXT,
  booked_for_phone TEXT,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'booked',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX appointment_bookings_agent_id_idx
  ON public.appointment_bookings(agent_id, start_time);

CREATE UNIQUE INDEX appointment_bookings_provider_booking_id_idx
  ON public.appointment_bookings(provider, provider_booking_id)
  WHERE provider_booking_id IS NOT NULL;

ALTER TABLE public.appointment_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own appointment bookings"
  ON public.appointment_bookings
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own appointment bookings"
  ON public.appointment_bookings
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own appointment bookings"
  ON public.appointment_bookings
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own appointment bookings"
  ON public.appointment_bookings
  FOR DELETE
  USING (auth.uid() = user_id);
