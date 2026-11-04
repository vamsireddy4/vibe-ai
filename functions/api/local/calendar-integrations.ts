import { calendarHandle } from "../../../server/calendar";
import { sharedRoute } from "../../../server/pages";

export const onRequest = sharedRoute((body, id, _origin, env) =>
  calendarHandle(body, id, { supabaseUrl: env.VITE_SUPABASE_URL ?? "", serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "" }),
);
