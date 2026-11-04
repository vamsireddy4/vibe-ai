import { ensureWhatsAppWebhookConfig } from "@/lib/whatsapp-webhook";
import { createContext, useContext, ReactNode, useCallback, useEffect, useState } from "react";
import { useClerk, useUser } from "@clerk/clerk-react";
import { supabase, getClerkToken } from "@/integrations/supabase/client";

type AppUser = {
  id: string;
  email: string;
  user_metadata: Record<string, any>;
  app_metadata: Record<string, any>;
};

type Profile = {
  id: string;
  user_id: string;
  full_name: string | null;
  gemini_api_key: string;
  analysis_model: string;
  onboarding_completed?: boolean;
  [key: string]: any;
};

interface AuthContextType {
  user: AppUser | null;
  session: { access_token: string | null } | null;
  profile: Profile | null;
  loading: boolean;
  needsOnboarding: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  createAccountProfile: (fullName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isLoaded, user: clerkUser } = useUser();
  const clerk = useClerk();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const user: AppUser | null = clerkUser
    ? {
        id: clerkUser.id,
        email: clerkUser.primaryEmailAddress?.emailAddress ?? "",
        user_metadata: {
          full_name: clerkUser.fullName ?? "",
          magicteams_enabled_spaces: ["voice", "sms", "whatsapp", "gmail"],
          ...clerkUser.unsafeMetadata,
        },
        app_metadata: { ...clerkUser.publicMetadata },
      }
    : null;

  // Keep a fresh Clerk token for pages that read session.access_token (tokens last ~60s).
  useEffect(() => {
    if (!clerkUser) {
      setToken(null);
      return;
    }
    const refresh = () => getClerkToken().then(setToken).catch(() => setToken(null));
    refresh();
    const timer = setInterval(refresh, 45_000);
    return () => clearInterval(timer);
  }, [clerkUser?.id]);

  // Load this user's profile row, creating it on first sign-in.
  const loadProfile = useCallback(async () => {
    if (!clerkUser) {
      setProfile(null);
      setProfileLoaded(true);
      return;
    }
    const fallback: Profile = {
      id: clerkUser.id,
      user_id: clerkUser.id,
      full_name: clerkUser.fullName,
      gemini_api_key: "",
      analysis_model: "",
    };
    try {
      const { data, error } = await supabase.from("profiles").select("*").eq("user_id", clerkUser.id).maybeSingle();
      if (error) throw error;
      if (data) {
        setProfile({ ...fallback, ...(data as any) });
      } else {
        const { data: created, error: insertError } = await supabase
          .from("profiles")
          .insert({
            user_id: clerkUser.id,
            full_name: clerkUser.fullName,
            email: clerkUser.primaryEmailAddress?.emailAddress ?? null,
          } as any)
          .select("*")
          .single();
        if (insertError) throw insertError;
        // New account: give it its own WhatsApp webhook URL + 6-digit verify token right away.
        void ensureWhatsAppWebhookConfig(clerkUser.id).catch(() => undefined);
        setProfile({ ...fallback, ...(created as any) });
      }
    } catch (error) {
      console.warn("Could not load profile from Supabase:", error);
      setProfile(fallback);
    } finally {
      setProfileLoaded(true);
    }
  }, [clerkUser?.id]);

  useEffect(() => {
    if (isLoaded) {
      setProfileLoaded(false);
      loadProfile();
    }
  }, [isLoaded, loadProfile]);

  return (
    <AuthContext.Provider
      value={{
        user,
        session: user ? { access_token: token } : null,
        profile,
        loading: !isLoaded || !profileLoaded,
        needsOnboarding: false,
        signOut: () => clerk.signOut(),
        refreshProfile: loadProfile,
        completeOnboarding: async () => {},
        createAccountProfile: async (fullName: string) => {
          const [firstName, ...rest] = fullName.trim().split(" ");
          await clerkUser?.update({ firstName, lastName: rest.join(" ") });
          if (clerkUser) {
            await supabase.from("profiles").update({ full_name: fullName.trim() } as any).eq("user_id", clerkUser.id);
          }
          await loadProfile();
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
