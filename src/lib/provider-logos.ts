import googleCalendarLogo from "@/assets/google-calendar-logo.svg";
import calcomLogo from "@/assets/calcom-logo.png";
import { GOHIGHLEVEL_LOGO as gohighlevelLogo } from "@/lib/brand-logos"; // the old PNG cropped its wordmark to "HighL"

type ProviderMeta = {
  id: string;
  name: string;
  logo: string;
};

function createSvgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const twilioLogo = createSvgDataUrl(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Twilio">
    <rect width="64" height="64" rx="16" fill="#F22F46"/>
    <circle cx="24" cy="24" r="6" fill="#FFFFFF"/>
    <circle cx="40" cy="24" r="6" fill="#FFFFFF"/>
    <circle cx="24" cy="40" r="6" fill="#FFFFFF"/>
    <circle cx="40" cy="40" r="6" fill="#FFFFFF"/>
  </svg>
`);

const telnyxLogo = createSvgDataUrl(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Telnyx">
    <rect width="64" height="64" rx="16" fill="#0F172A"/>
    <path d="M17 20h10.5L32 27.5 36.5 20H47L37.5 35 47 44H36.5L32 36.5 27.5 44H17l9.5-9L17 20Z" fill="#B9FF66"/>
  </svg>
`);

const logoDataUrlCache = new Map<string, Promise<string>>();

async function assetUrlToDataUrl(assetUrl: string): Promise<string> {
  const response = await fetch(assetUrl);
  const blob = await response.blob();

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read logo asset"));
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read logo asset"));
    reader.readAsDataURL(blob);
  });
}

export function getCachedLogoDataUrl(assetUrl: string): Promise<string> {
  const existing = logoDataUrlCache.get(assetUrl);
  if (existing) return existing;

  const pending = assetUrlToDataUrl(assetUrl);
  logoDataUrlCache.set(assetUrl, pending);
  return pending;
}

export const PHONE_PROVIDER_META: Record<string, ProviderMeta> = {
  twilio: {
    id: "twilio",
    name: "Twilio",
    logo: twilioLogo,
  },
  telnyx: {
    id: "telnyx",
    name: "Telnyx",
    logo: telnyxLogo,
  },
};

export const CALENDAR_PROVIDER_META: Record<string, ProviderMeta> = {
  google_calendar: {
    id: "google_calendar",
    name: "Google Calendar",
    logo: googleCalendarLogo,
  },
  cal_com: {
    id: "cal_com",
    name: "Cal.com",
    logo: calcomLogo,
  },
  gohighlevel: {
    id: "gohighlevel",
    name: "GoHighLevel",
    logo: gohighlevelLogo,
  },
};
