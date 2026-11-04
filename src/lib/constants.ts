// Shared constants for the application
// Admin email is used to grant unlimited access - set via environment variable

const sanitizeEnvValue = (value: string | undefined) =>
  String(value || "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "");

export const ADMIN_EMAIL = sanitizeEnvValue(import.meta.env.VITE_ADMIN_EMAIL) || "saphaarelabs@gmail.com";
