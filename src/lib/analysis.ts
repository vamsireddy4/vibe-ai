// Text analysis for the website on Meta Muse Spark (voice agent /ask/analyze, billed to the Meta key, no user key):
// Knowledge Base extraction, call summaries, CSV analysis and WhatsApp message writing. Agent prompts: enhanceAgentPrompt.
import { authJsonHeaders } from "@/lib/local-functions";
import { getClerkToken } from "@/integrations/supabase/client";

export interface CsvColumnDef {
  key: string;
  label: string;
  type: "text" | "phone" | "date" | "number" | "email";
}

export interface CsvAnalysis {
  columns: CsvColumnDef[];
  rows: Record<string, string>[];
  summary: string;
  totalRows: number;
}

const API = `${import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`}/ask`;

/** One Muse Spark answer. url: the server reads that web page and adds its text. image: a data: URL. */
async function muse(prompt: string, extra: { url?: string; image?: string } = {}): Promise<string> {
  const res = await fetch(`${API}/analyze`, { method: "POST", headers: await authJsonHeaders(), body: JSON.stringify({ prompt, ...extra }) }).catch(() => null);
  if (!res) throw new Error("Couldn't reach the Vibe AI analysis service. Check your connection and try again.");
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.text !== "string") throw new Error(data?.error || `Analysis failed (HTTP ${res.status})`);
  return data.text.trim();
}

function parseJsonReply(text: string) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed);
}

function getCsvAnalysisPrompt(preview: string, totalRows: number) {
  return `You are a CSV data analyst. Analyze this CSV data and return a JSON response.

The CSV has ${totalRows} total data rows. Here is the data (header + up to 200 rows):

\`\`\`
${preview}
\`\`\`

Return ONLY valid JSON (no markdown, no code blocks) with this exact structure:
{
  "columns": [
    {
      "key": "original_csv_header_name",
      "label": "Human Readable Label",
      "type": "text|phone|date|number|email"
    }
  ],
  "rows": [
    { "original_csv_header_1": "value1", "original_csv_header_2": "value2" }
  ],
  "summary": "Brief one-line summary of what this data contains"
}

Rules:
- "columns" should list ALL columns found in the CSV, with clean human-readable labels
- Detect column types: phone numbers as "phone", emails as "email", dates as "date", numeric fields as "number", otherwise "text"
- "rows" should return cleaned/normalized data rows for the provided preview only
- Preserve the original CSV header names as the "key" values
- Clean phone numbers into a consistent readable format when possible
- Trim whitespace and normalize obvious formatting issues
- "summary" should describe the dataset in one sentence`;
}


function sanitizeAnalysis(parsed: any, totalRows: number): CsvAnalysis {
  const columns = Array.isArray(parsed?.columns) ? parsed.columns : [];
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const summary = typeof parsed?.summary === "string" ? parsed.summary : "";

  return {
    columns: columns.map((column: any) => ({
      key: String(column?.key || ""),
      label: String(column?.label || column?.key || ""),
      type: ["text", "phone", "date", "number", "email"].includes(column?.type) ? column.type : "text",
    })).filter((column: CsvColumnDef) => column.key),
    rows: rows
      .filter((row: any) => row && typeof row === "object" && !Array.isArray(row))
      .map((row: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, value == null ? "" : String(value).trim()])
        )
      ),
    summary,
    totalRows,
  };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result.map((value) => value.replace(/^"(.*)"$/, "$1").trim());
}

function humanizeCsvHeader(header: string) {
  return header
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferCsvColumnType(key: string, values: string[]): CsvColumnDef["type"] {
  const nonEmptyValues = values.map((value) => value.trim()).filter(Boolean);
  const keyLower = key.toLowerCase();

  if (keyLower.includes("email")) return "email";
  if (keyLower.includes("phone") || keyLower.includes("mobile") || keyLower.includes("whatsapp")) return "phone";
  if (keyLower.includes("date") || keyLower.includes("dob") || keyLower.includes("time")) return "date";

  if (nonEmptyValues.length === 0) return "text";

  const emailLike = nonEmptyValues.every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  if (emailLike) return "email";

  const phoneLike = nonEmptyValues.every((value) => /^[+\d()\-\s]{7,}$/.test(value));
  if (phoneLike) return "phone";

  const dateLike = nonEmptyValues.every((value) => !Number.isNaN(Date.parse(value)));
  if (dateLike) return "date";

  const numberLike = nonEmptyValues.every((value) => /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, "")));
  if (numberLike) return "number";

  return "text";
}

function buildLocalCsvFallback(csvContent: string): CsvAnalysis {
  const normalized = csvContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { columns: [], rows: [], summary: "CSV file is empty.", totalRows: 0 };
  }

  const headers = parseCsvLine(lines[0]).map((header, index) => header || `column_${index + 1}`);
  const dataLines = lines.slice(1, 201);
  const rows = dataLines.map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, String(cells[index] ?? "").trim()]));
  });

  const columns: CsvColumnDef[] = headers.map((header) => ({
    key: header,
    label: humanizeCsvHeader(header),
    type: inferCsvColumnType(
      header,
      rows.map((row) => row[header] || ""),
    ),
  }));

  const totalRows = Math.max(lines.length - 1, 0);
  const summary =
    totalRows > 0
      ? `Detected ${totalRows} contact row${totalRows === 1 ? "" : "s"} across ${headers.length} field${headers.length === 1 ? "" : "s"}.`
      : `Detected ${headers.length} field${headers.length === 1 ? "" : "s"} with no data rows.`;

  return {
    columns,
    rows,
    summary,
    totalRows,
  };
}

/** Understand a contacts CSV (columns, types, cleaned rows). Falls back to a local parser if the model is unavailable. */
export async function analyzeCsv(csvContent: string): Promise<CsvAnalysis> {
  const lines = csvContent.trim().split("\n");
  const preview = lines.slice(0, Math.min(lines.length, 201)).join("\n");
  const totalRows = Math.max(lines.length - 1, 0);
  try {
    return sanitizeAnalysis(parseJsonReply(await muse(getCsvAnalysisPrompt(preview, totalRows))), totalRows);
  } catch (error) {
    const local = buildLocalCsvFallback(csvContent);
    if (local.columns.length > 0) return { ...local, summary: `${local.summary} AI analysis was unavailable, so a local CSV parser was used.` };
    throw error;
  }
}

/** Plain text answer for a prompt (e.g. WhatsApp message writing). */
export const generateText = (prompt: string) => muse(prompt);

const KNOWLEDGE_RULES =
  "You are a knowledge extraction assistant. Extract and structure ALL useful information into clean plain text for an AI phone agent. Preserve important facts, policies, pricing, contact info, services, procedures, FAQs, hours, addresses and business rules. Output only the extracted text.";

/** PDF/DOCX and other documents to text on the server (Cloudflare's document converter, not a model). */
async function documentToText(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/local/document-text", { method: "POST", headers: { Authorization: `Bearer ${(await getClerkToken()) ?? ""}` }, body }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok || typeof data?.text !== "string") throw new Error(data?.error || "Couldn't read this document. Try a PDF or DOCX, or paste the text as a .txt file.");
  return data.text;
}

const toDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error("Couldn't read the image."));
  r.readAsDataURL(file);
});

/** Knowledge from an uploaded file: text and documents are read as text, images are read by Muse directly. */
export async function extractKnowledgeFromFile(file: File): Promise<string> {
  if (file.type.startsWith("image/")) return muse(`${KNOWLEDGE_RULES}\n\nThe content is in the attached image.`, { image: await toDataUrl(file) });
  const isText = /(?:text\/.*|application\/json)/i.test(file.type) || /\.(txt|md|csv)$/i.test(file.name);
  const text = isText ? await file.text() : await documentToText(file);
  return muse(`${KNOWLEDGE_RULES}\n\nFile content:\n${text.slice(0, 120000)}`);
}

/** Knowledge from a website: the server reads the page, Muse extracts what matters. */
export function extractKnowledgeFromUrl(url: string, existingDescription?: string | null): Promise<string> {
  const note = existingDescription?.trim() ? `\n\nAdditional context from the user:\n${existingDescription.trim()}` : "";
  return muse(`${KNOWLEDGE_RULES}${note}`, { url: String(url || "").trim() });
}

/** Short operational summary of a call. */
export function summarizeCallTranscript(params: {
  transcript: string;
  direction?: string | null;
  agentName?: string | null;
  durationSeconds?: number | null;
  phoneNumber?: string | null;
}): Promise<string> {
  return muse(`You are an expert call analyst. Produce a concise operational summary for this phone call.

Return plain text with:
1. Purpose: one sentence
2. Key points: 2-4 short bullet points
3. Outcome: one short sentence
4. Action items: one short sentence or "None"
5. Sentiment: positive, neutral, or negative

Call details:
- Direction: ${params.direction || "unknown"}
- Agent: ${params.agentName || "Unknown"}
- Duration: ${params.durationSeconds != null ? `${Math.floor(params.durationSeconds / 60)}m ${params.durationSeconds % 60}s` : "Unknown"}
- Phone: ${params.phoneNumber || "Unknown"}

Transcript:
${params.transcript}`);
}

/**
 * Write an agent's system prompt in the standard 6-section structure (role, task, rules, context, few-shot
 * examples, constraints) with Meta Muse Spark on the voice agent. Used by Generate with AI, onboarding and Ask Vibe.
 */
export async function enhanceAgentPrompt(params: {
  name?: string;
  industry?: string;
  strategy?: string;
  description: string;
}): Promise<string> {
  const base = import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`;
  const res = await fetch(`${base}/ask/prompt`, { method: "POST", headers: await authJsonHeaders(), body: JSON.stringify(params) }).catch(() => null);
  if (!res) throw new Error("Could not reach the AI prompt writer.");
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.prompt !== "string") throw new Error(data?.error || `Prompt generation failed (HTTP ${res.status})`);
  return data.prompt;
}

