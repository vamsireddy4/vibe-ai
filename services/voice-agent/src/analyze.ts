/**
 * POST /ask/analyze: the website's text analysis on Meta Muse Spark (Knowledge Base extraction, call summaries,
 * CSV analysis, WhatsApp message writing). Signed-in users only (the Pages proxy checks the Clerk token).
 *   { prompt, url?, image? }  ->  { text }
 *   url: this server reads the web page and appends its text to the prompt (browsers can't fetch other sites).
 *   image: a data: URL Muse reads alongside the prompt.
 */
import { config } from "./config.js";

const MAX_PROMPT = 150_000;
const MAX_PAGE = 120_000;
const MAX_IMAGE = 8_000_000; // data URL length

const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

/** Readable text of an HTML page: no scripts/styles/tags, entities decoded, whitespace collapsed. Exported for the selfcheck. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pageText(raw: string): Promise<string> {
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https links can be read.");
  const r = await fetch(url, { headers: { "User-Agent": "VibeAI-KnowledgeReader/1.0", Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`The website answered ${r.status}.`);
  const body = (await r.text()).slice(0, 2_000_000);
  const text = /html/i.test(r.headers.get("content-type") ?? "") ? htmlToText(body) : body.trim();
  if (!text) throw new Error("The page had no readable text.");
  return text.slice(0, MAX_PAGE);
}

export async function askAnalyze(req: Request): Promise<Response> {
  let b: any;
  try { b = await req.json(); } catch { return fail(400, "invalid JSON"); }
  let prompt = typeof b?.prompt === "string" ? b.prompt.slice(0, MAX_PROMPT) : "";
  if (!prompt.trim()) return fail(400, "prompt is required");
  if (typeof b?.url === "string" && b.url.trim()) {
    try { prompt += `\n\nWebsite: ${b.url.trim()}\nWebsite content:\n${await pageText(b.url.trim())}`; } catch (e) { return fail(422, `Couldn't read that website: ${(e as Error).message}`); }
  }
  const image = typeof b?.image === "string" && /^data:image\/[\w.+-]+;base64,/.test(b.image) && b.image.length <= MAX_IMAGE ? b.image : "";
  const r = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.museApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.3",
      reasoning_effort: "minimal",
      max_tokens: 4000,
      messages: [{ role: "user", content: image ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] : prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => e as Error);
  if (r instanceof Error) return fail(502, r.message);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return fail(502, `Muse ${r.status}: ${data?.error?.message ?? ""}`.slice(0, 300));
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) return fail(502, "The model returned nothing. Try again.");
  return new Response(JSON.stringify({ text }), { headers: { "Content-Type": "application/json" } });
}
