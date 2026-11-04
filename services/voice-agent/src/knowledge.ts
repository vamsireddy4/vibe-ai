/**
 * The agent's knowledge base on calls: its Ready knowledge items (extracted from files and websites by the
 * user's Analysis AI) are added to the call's instructions, so the agent answers from them.
 */
// ponytail: whole items go into the prompt (capped); add retrieval (search the items per question) if bases get large.
const MAX_CHARS = 24_000; // ~6k tokens: enough for a typical business; keeps first-word latency reasonable

export async function withKnowledge(prompt: string | undefined, userId: string, agentId?: string): Promise<string | undefined> {
  if (!agentId) return prompt;
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const r = await fetch(
    `${url}/rest/v1/knowledge_base_items?select=title,content&agent_id=eq.${encodeURIComponent(agentId)}&user_id=eq.${encodeURIComponent(userId)}&processing_status=eq.completed&order=created_at.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  ).catch(() => null);
  const items: { title: string; content: string | null }[] = r?.ok ? await r.json() : [];
  let budget = MAX_CHARS;
  const parts: string[] = [];
  for (const it of items) {
    const text = (it.content ?? "").trim();
    if (!text || budget <= 0) continue;
    const piece = `## ${it.title}\n${text.slice(0, budget)}`;
    budget -= piece.length;
    parts.push(piece);
  }
  if (!parts.length) return prompt;
  return `${prompt?.trim() ?? ""}

KNOWLEDGE BASE. Use these facts to answer the caller's questions. If the answer isn't here, say you'll have the team follow up; never invent details.
${parts.join("\n\n")}`.trim();
}
