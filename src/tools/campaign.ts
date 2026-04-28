/**
 * Campaign-scoped tools — handouts and chat.
 */

import { z } from "zod";
import type { FirebaseRestClient, Handout, ChatMessage } from "../client.js";

// ─── search_handouts ────────────────────────────────────────────────────

export const SearchHandoutsInput = z.object({
  query: z.string().describe("Case-insensitive substring to match."),
  includeNotes: z
    .boolean()
    .optional()
    .describe("If true, also match against the handout body (notes). Slower."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Max results (default 20)."),
});

export async function searchHandouts(
  client: FirebaseRestClient,
  input: z.infer<typeof SearchHandoutsInput>,
) {
  const matches = await client.searchHandouts(input.query, {
    limit: input.limit,
    includeNotes: input.includeNotes,
  });
  const text = matches
    .map((h) => `• ${h.name} — id ${h.id}${h.tags ? ` [${h.tags}]` : ""}`)
    .join("\n");
  return {
    text: text || `(no handouts match "${input.query}")`,
    structuredContent: { handouts: matches.map(stripBigFields) },
  };
}

function stripBigFields(h: Handout) {
  // Drop the (potentially long) notes/gmnotes from list responses; callers can
  // fetch the full handout via get_handout if they need them.
  const { notes: _n, gmnotes: _g, ...rest } = h;
  return rest;
}

// ─── get_handout ────────────────────────────────────────────────────────

export const GetHandoutInput = z.object({
  handoutId: z.string().describe("Handout UID."),
  includeGmNotes: z
    .boolean()
    .optional()
    .describe("If true, include `gmnotes` in the response."),
});

export async function getHandout(
  client: FirebaseRestClient,
  input: z.infer<typeof GetHandoutInput>,
) {
  const h = await client.getHandout(input.handoutId);
  if (!h) {
    return { text: `Handout ${input.handoutId} not found.`, structuredContent: { found: false } };
  }
  const out = input.includeGmNotes ? h : { ...h, gmnotes: undefined };
  const text = [
    `# ${h.name}`,
    h.tags ? `Tags: ${h.tags}` : null,
    h.notes ? `\n${h.notes}` : null,
    input.includeGmNotes && h.gmnotes ? `\nGM NOTES:\n${h.gmnotes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { text, structuredContent: out };
}

// ─── search_chat ────────────────────────────────────────────────────────

export const SearchChatInput = z.object({
  recent: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Number of most recent messages to scan (default 100)."),
  contains: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring filter on `who` or content."),
  type: z
    .string()
    .optional()
    .describe(
      "Optional message type filter — e.g. 'general', 'rollresult', 'whisper', 'emote'.",
    ),
});

export async function searchChat(
  client: FirebaseRestClient,
  input: z.infer<typeof SearchChatInput>,
) {
  const recent = await client.getRecentChat(input.recent ?? 100);
  let filtered = recent;
  if (input.type) filtered = filtered.filter((m) => m.type === input.type);
  if (input.contains) {
    const q = input.contains.toLowerCase();
    filtered = filtered.filter(
      (m) =>
        (m.who ?? "").toLowerCase().includes(q) ||
        (m.content ?? "").toLowerCase().includes(q) ||
        (m.origRoll ?? "").toLowerCase().includes(q),
    );
  }
  const text = filtered
    .map(formatChatLine)
    .join("\n");
  return {
    text: text || "(no matches)",
    structuredContent: { messages: filtered },
  };
}

function formatChatLine(m: ChatMessage): string {
  const ts = formatTs(m.timestamp);
  if (m.type === "rollresult") {
    let total: string | null = null;
    try {
      const parsed = JSON.parse(m.content);
      if (parsed && typeof parsed.total !== "undefined") total = String(parsed.total);
    } catch {}
    return `[${ts}] ${m.who} rolled ${m.origRoll ?? "?"}${total ? ` = ${total}` : ""}`;
  }
  return `[${ts}] ${m.who}: ${(m.content ?? "").slice(0, 200)}`;
}

function formatTs(t: unknown): string {
  const n = typeof t === "number" ? t : Number(t);
  if (!Number.isFinite(n) || n <= 0) return "?";
  try {
    return new Date(n).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "?";
  }
}
