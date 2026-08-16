/**
 * World-state tools: pages, tokens, initiative, players.
 *
 * Save this as src/tools/world.ts in the roll20-character-mcp-server repo.
 */

import { z } from "zod";
import type {
  FirebaseRestClient,
  PageRecord,
  TokenRecord,
  PlayerRecord,
  InitiativeEntry,
} from "../client.js";

// ─── list_pages ─────────────────────────────────────────────────────────

export const ListPagesInput = z.object({
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include archived pages (default false)."),
});

export async function listPages(
  client: FirebaseRestClient,
  input: z.infer<typeof ListPagesInput>,
) {
  const all = await client.listPages();
  const filtered = input.includeArchived ? all : all.filter((p) => !p.archived);
  const activeId = await client.getActivePageId();
  const text = filtered
    .map((p) => {
      const marker = p.id === activeId ? " ← ACTIVE" : "";
      const dim = p.width && p.height ? ` ${p.width}x${p.height}` : "";
      return `• ${p.name || "(unnamed)"}${dim}${marker} — id ${p.id}`;
    })
    .join("\n");
  // Slim each page record — only the essentials for a list view.
  // Callers can fetch full detail via get_page if needed.
  const slim = filtered.map((p) => ({
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    archived: p.archived ?? false,
    isActive: p.id === activeId,
  }));
  return {
    text:
      (text || "(no pages)") +
      `\n\n${filtered.length} page${filtered.length === 1 ? "" : "s"}.`,
    structuredContent: { pages: slim, activePageId: activeId },
  };
}

// ─── get_page ───────────────────────────────────────────────────────────

export const GetPageInput = z.object({
  pageId: z.string().describe("Page UID. Use list_pages to find one."),
});

export async function getPage(
  client: FirebaseRestClient,
  input: z.infer<typeof GetPageInput>,
) {
  const p = await client.getPage(input.pageId);
  if (!p) {
    return {
      text: `Page ${input.pageId} not found.`,
      structuredContent: { found: false },
    };
  }
  const lines = [
    `# ${p.name || "(unnamed page)"}`,
    `Dimensions: ${p.width ?? "?"} × ${p.height ?? "?"} ${p.scale_units ?? ""}`,
    p.scale_number ? `Scale: ${p.scale_number} per square` : null,
    p.grid_type ? `Grid: ${p.grid_type}` : null,
    p.showgrid !== undefined ? `Show grid: ${p.showgrid}` : null,
    p.showlighting !== undefined ? `Lighting: ${p.showlighting}` : null,
    p.background_color ? `Background: ${p.background_color}` : null,
    p.archived ? `(archived)` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { text: lines, structuredContent: p };
}

// ─── list_tokens ────────────────────────────────────────────────────────

export const ListTokensInput = z.object({
  pageId: z
    .string()
    .optional()
    .describe(
      "Page UID. If omitted, uses the currently-active player page (campaign.playerpageid).",
    ),
  layer: z
    .string()
    .optional()
    .describe(
      "Optional layer filter — 'objects' (PCs/NPCs visible to players), 'gmlayer' (GM-only), 'map' (background art).",
    ),
  representsCharacterId: z
    .string()
    .optional()
    .describe("If set, only tokens whose `represents` field matches this character ID."),
  contains: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring filter on token name."),
});

export async function listTokens(
  client: FirebaseRestClient,
  input: z.infer<typeof ListTokensInput>,
) {
  let pageId = input.pageId;
  if (!pageId) {
    pageId = (await client.getActivePageId()) ?? undefined;
    if (!pageId) {
      return {
        text:
          "No pageId given and no active page is set on the campaign. Pass pageId explicitly (use list_pages).",
        structuredContent: { tokens: [] },
      };
    }
  }
  const all = await client.listTokens(pageId);
  let filtered = all;
  if (input.layer) filtered = filtered.filter((t) => t.layer === input.layer);
  if (input.representsCharacterId)
    filtered = filtered.filter((t) => t.represents === input.representsCharacterId);
  if (input.contains) {
    const q = input.contains.toLowerCase();
    filtered = filtered.filter((t) => (t.name ?? "").toLowerCase().includes(q));
  }
  const text = filtered
    .map(formatTokenLine)
    .join("\n");
  return {
    text:
      (text || "(no tokens match)") +
      `\n\n${filtered.length} token${filtered.length === 1 ? "" : "s"} on page ${pageId}.`,
    structuredContent: { pageId, tokens: filtered },
  };
}

function formatTokenLine(t: TokenRecord): string {
  const layer = t.layer ? ` [${t.layer}]` : "";
  const hp =
    t.bar1_value !== undefined
      ? ` bar1=${t.bar1_value}${t.bar1_max ? `/${t.bar1_max}` : ""}`
      : "";
  const ac =
    t.bar2_value !== undefined
      ? ` bar2=${t.bar2_value}${t.bar2_max ? `/${t.bar2_max}` : ""}`
      : "";
  const status = t.status_markers ? ` status=[${t.status_markers}]` : "";
  return `• ${t.name || "(unnamed)"}${layer}${hp}${ac}${status} — id ${t.id}`;
}

// ─── get_token ──────────────────────────────────────────────────────────

export const GetTokenInput = z.object({
  pageId: z.string().describe("Page UID where the token lives."),
  tokenId: z.string().describe("Token UID."),
});

export async function getToken(
  client: FirebaseRestClient,
  input: z.infer<typeof GetTokenInput>,
) {
  const t = await client.getToken(input.pageId, input.tokenId);
  if (!t) {
    return {
      text: `Token ${input.tokenId} not found on page ${input.pageId}.`,
      structuredContent: { found: false },
    };
  }
  return { text: `# ${t.name || "(unnamed)"}\n` + JSON.stringify(t, null, 2), structuredContent: t };
}

// ─── get_initiative ─────────────────────────────────────────────────────

export const GetInitiativeInput = z.object({});

export async function getInitiative(
  client: FirebaseRestClient,
  _input: z.infer<typeof GetInitiativeInput>,
) {
  const order = await client.getInitiative();
  if (order.length === 0) {
    return {
      text: "(initiative tracker is empty)",
      structuredContent: { entries: [] },
    };
  }

  // Try to enrich with token names by fetching the page each token belongs to.
  // For perf, only fetch pages we haven't seen.
  const pageCache: Record<string, TokenRecord[]> = {};
  const enriched = await Promise.all(
    order.map(async (e, i) => {
      let name = e.custom || "(unknown)";
      if (e.id !== "-1" && e.pageid) {
        if (!pageCache[e.pageid]) {
          pageCache[e.pageid] = await client.listTokens(e.pageid);
        }
        const tok = pageCache[e.pageid].find((t) => t.id === e.id);
        if (tok?.name) name = tok.name;
      }
      return { order: i + 1, ...e, name };
    }),
  );

  const text = enriched
    .map((e) => `${e.order === 1 ? "▶" : " "} ${String(e.order).padStart(2)}. [${e.pr}] ${e.name}`)
    .join("\n");
  return {
    text,
    structuredContent: { entries: enriched },
  };
}

// ─── list_players ───────────────────────────────────────────────────────

export const ListPlayersInput = z.object({
  onlineOnly: z.boolean().optional().describe("If true, only return players currently online."),
});

export async function listPlayers(
  client: FirebaseRestClient,
  input: z.infer<typeof ListPlayersInput>,
) {
  const all = await client.listPlayers();
  const filtered = input.onlineOnly ? all.filter((p) => !!p.online) : all;
  const text = filtered
    .map((p) => {
      const status = p.online ? "● online" : "○ offline";
      const last = p.lastActive
        ? ` last:${new Date(p.lastActive).toISOString().slice(0, 16).replace("T", " ")}`
        : "";
      return `${status} ${p.displayname || "(unnamed)"}${last} — id ${p.id}`;
    })
    .join("\n");
  return {
    text:
      (text || "(no players match)") +
      `\n\n${filtered.length} player${filtered.length === 1 ? "" : "s"}.`,
    structuredContent: { players: filtered },
  };
}
