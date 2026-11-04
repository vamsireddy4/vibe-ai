import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
  user?: {
    id: string;
    fullName: string | null;
    primaryEmailAddress?: { emailAddress: string } | null;
    unsafeMetadata?: Record<string, unknown>;
    publicMetadata?: Record<string, unknown>;
  } | null;
  signOut: () => Promise<void>;
};

const clerk = () => (window as unknown as { Clerk?: ClerkGlobal }).Clerk;

// Clerk session token (short-lived; getToken() refreshes it). Supabase verifies it via
// the Clerk third-party auth integration, and RLS reads the user id from its "sub" claim.
export const getClerkToken = async () => (await clerk()?.session?.getToken()) ?? null;

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  accessToken: getClerkToken,
});

// The Edge Functions run on this site's Cloudflare deployment (/fn/<name>, see scripts/build-edge.mjs),
// not on Supabase: route supabase.functions.invoke() there. Local dev keeps the Vite /api/local routes.
if (typeof window !== "undefined" && !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
  (supabase as unknown as { functionsUrl: URL }).functionsUrl = new URL("/fn", window.location.origin);
}

// Login lives in Clerk, so supabase.auth is unavailable with accessToken set.
// Existing pages still call supabase.auth.getSession()/getUser(); answer them from Clerk.
const clerkUser = () => {
  const u = clerk()?.user;
  return u
    ? {
        id: u.id,
        email: u.primaryEmailAddress?.emailAddress ?? "",
        user_metadata: { full_name: u.fullName ?? "", magicteams_enabled_spaces: ["voice", "sms", "whatsapp", "gmail"], ...u.unsafeMetadata },
        app_metadata: { ...u.publicMetadata },
      }
    : null;
};

const getSession = async () => {
  const token = await getClerkToken();
  const user = clerkUser();
  return { data: { session: token && user ? { access_token: token, user } : null }, error: null };
};

const notSupported = async () => ({ data: null, error: new Error("Sign-in is handled by Clerk.") });

(supabase as unknown as { auth: unknown }).auth = {
  getSession,
  refreshSession: getSession,
  getUser: async () => ({ data: { user: clerkUser() }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  updateUser: async () => ({ data: { user: clerkUser() }, error: null }),
  signOut: async () => {
    await clerk()?.signOut();
    return { error: null };
  },
  signUp: notSupported,
  signInWithPassword: notSupported,
  signInWithOAuth: notSupported,
  linkIdentity: notSupported,
  resetPasswordForEmail: notSupported,
};
