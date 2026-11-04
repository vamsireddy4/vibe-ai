import { minutesHandle } from "../../../server/minutes";
import { sharedRoute } from "../../../server/pages";

export const onRequest = sharedRoute((body, id, _origin, env) =>
  minutesHandle(body, id, { supabaseUrl: env.VITE_SUPABASE_URL ?? "", serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "" }),
);
