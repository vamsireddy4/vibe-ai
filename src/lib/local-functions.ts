import { getClerkToken, supabase } from "@/integrations/supabase/client";

export const isLocalDevHost = () =>
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

export const invokeAuthedFunction = async <T,>(functionName: string, body: Record<string, unknown>) => {
  const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
  const { data, error } = await supabase.functions.invoke(functionName, {
    headers: accessToken
      ? {
          Authorization: `Bearer ${accessToken}`,
        }
      : undefined,
    body,
  });

  if (error) throw error;
  return (data ?? {}) as T;
};

/** POST to a local dev route (/api/local/...) as the signed-in user; the route reads the user from the Clerk token. */
/** JSON + the Clerk session token, for our own server routes and the voice agent proxy. */
export const authJsonHeaders = async () => ({ "Content-Type": "application/json", Authorization: `Bearer ${(await getClerkToken()) ?? ""}` });

export const localApi = async <T = any,>(path: string, body: Record<string, unknown>) => {
  const res = await fetch(path, {
    method: "POST",
    headers: await authJsonHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
};
