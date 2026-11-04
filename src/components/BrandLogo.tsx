import { cn } from "@/lib/utils";

// Vibe AI wordmark. Cloudinary trims the padding and makes the white background transparent;
// it's black, so dark mode inverts it to white.
const LOGO_URL = "https://res.cloudinary.com/dj9ecbykc/image/upload/e_make_transparent:10/e_trim/v1793716012/Vibe_AI_Minimalist_Logo_kbzcfe.png";

export default function BrandLogo({ className }: { className?: string }) {
  return <img src={LOGO_URL} alt="Vibe AI" className={cn("h-6 w-auto select-none dark:invert", className)} draggable={false} />;
}

// Just the V mark (collapsed sidebar), same Cloudinary trim + transparency.
const MARK_URL = "https://res.cloudinary.com/dj9ecbykc/image/upload/e_make_transparent:10/e_trim/v1793716013/Minimalist_Black_V-Marked_Logo_uva1uu.png";

export function BrandMark({ className }: { className?: string }) {
  return <img src={MARK_URL} alt="Vibe AI" className={cn("h-6 w-auto select-none dark:invert", className)} draggable={false} />;
}
