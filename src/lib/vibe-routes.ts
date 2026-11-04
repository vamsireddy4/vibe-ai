export type VibeSpace = "voice" | "sms" | "whatsapp" | "gmail";

export const ALL_VIBE_SPACES: VibeSpace[] = ["voice", "sms", "whatsapp", "gmail"];
// Every channel shows by default; the admin can still turn one off per user.
export const DEFAULT_VIBE_SPACES: VibeSpace[] = [...ALL_VIBE_SPACES];

// App pages live at /<space>/<page> (e.g. /voice/campaigns); old /magicteams/... links redirect (App.tsx).
export const VIBE_BASE = "";
export const DASHBOARD_PATH = "/dashboard";

/** True on the signed-in app's pages (sidebar layout, Ask Vibe), not on /admin, /auth, /onboarding... */
export function isAppPath(pathname: string) {
  return pathname === DASHBOARD_PATH || /^\/(voice|sms|whatsapp|gmail)(\/|$)/.test(pathname);
}

export function getVibePath(space: VibeSpace, leaf = "dashboard") {
  return `${VIBE_BASE}/${space}/${leaf}`;
}

export function getVibeSpaceFromPath(pathname: string): VibeSpace {
  if (pathname.startsWith(`${VIBE_BASE}/sms`)) return "sms";
  if (pathname.startsWith(`${VIBE_BASE}/whatsapp`)) return "whatsapp";
  if (pathname.startsWith(`${VIBE_BASE}/gmail`)) return "gmail";
  return "voice";
}

export function normalizeVibeSpaces(value: unknown): VibeSpace[] {
  if (!Array.isArray(value)) return [...DEFAULT_VIBE_SPACES];

  const normalized = value.filter((entry): entry is VibeSpace =>
    typeof entry === "string" && ALL_VIBE_SPACES.includes(entry as VibeSpace),
  );

  return normalized.length > 0 ? Array.from(new Set(normalized)) : [...DEFAULT_VIBE_SPACES];
}
