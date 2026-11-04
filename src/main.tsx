import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App.tsx";
import "./index.css";

// A deploy replaced the page files this tab was about to preload: reload once to get the new ones
// (same rule as lazy() in App.tsx; the shared timestamp stops a reload loop).
window.addEventListener("vite:preloadError", (event) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem("vibe-chunk-reload-at")) || 0; } catch { /* storage blocked */ }
  if (Date.now() - last < 30_000) return; // already reloaded just now: let the error show
  event.preventDefault();
  try { sessionStorage.setItem("vibe-chunk-reload-at", String(Date.now())); } catch { /* storage blocked */ }
  window.location.reload();
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!clerkKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env");
}

createRoot(rootElement).render(
  <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/login">
    <App />
  </ClerkProvider>
);
