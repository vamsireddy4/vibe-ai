// POST /api/local/document-text (multipart "file", Authorization: Bearer <Clerk token>) -> { text }
// Turns an uploaded document (PDF, DOCX, XLSX, ...) into plain text with Cloudflare's toMarkdown, so knowledge files
// work with every Analysis AI provider (not only those that read binary files). Signed-in users only, 10 MB max.
import { callerOf, json, type PagesContext } from "../../../server/pages";

type Ctx = PagesContext & { env: PagesContext["env"] & { AI?: { toMarkdown(docs: { name: string; blob: Blob }[]): Promise<{ name: string; data?: string; format?: string; error?: string }[]> } } };

export const onRequest = async ({ request, env }: Ctx) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const caller = await callerOf(request, env);
  if (!caller) return json(401, { error: "Sign in again to upload files." });
  if (!env.AI) return json(503, { error: "Document reading isn't set up on this deployment." });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return json(400, { error: "No file was uploaded." });
  if (file.size > 10 * 1024 * 1024) return json(413, { error: "Files can be up to 10 MB." });
  const [result] = await env.AI.toMarkdown([{ name: file.name, blob: new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }) }]);
  const text = (result?.data ?? "").trim();
  if (result?.format === "error" || !text) return json(422, { error: result?.error || "No readable text was found in this file." });
  return json(200, { text });
};
