import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Case-insensitive "does any of these contain the search text" (empty search matches everything). */
export function matchesSearch(search: string, values: (string | null | undefined)[]) {
  const term = search.trim().toLowerCase();
  return !term || values.some((v) => v?.toLowerCase().includes(term));
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
