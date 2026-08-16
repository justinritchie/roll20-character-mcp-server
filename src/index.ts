#!/usr/bin/env node
/**
 * Roll20 Character MCP Server (read-only).
 *
 * Reads a Roll20 D&D 5e (2024 / Beacon) character sheet and adjacent campaign
 * data directly from Roll20's Firebase Realtime Database via REST. No browser
 * automation, no DOM scraping — just a Firebase ID token, the campaign
 * storage path, and well-known Firebase paths.
 *
 * Config resolution order (later wins):
 *   1. ~/.mcp-credentials/roll20.json   (written by mcp-auth-bridge)
 *   2. Environment variables: ROLL20_FIREBASE_DB_URL, ROLL20_FIREBASE_ID_TOKEN,
 *      ROLL20_CAMPAIGN_PATH, ROLL20_DEFAULT_CHARACTER_ID, ROLL20_PLAYER_ID
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FirebaseRestClient } from "./client.js";
import { resolveConfig } from "./config.js";
import {
  CharacterIdInput,
  ListCharactersInput,
  ListSpellsInput,
  GetSpellInput,
  GetRawAttributesInput,
  listCharacters,
  getCharacterSummary,
  getCombatState,
  listSpells,
  getSpell,
  listAttacks,
  listFeatures,
  getInventory,
  getCurrencies,
  getRawAttributes,
} from "./tools/character.js";
import {
  SearchHandoutsInput,
  GetHandoutInput,
  SearchChatInput,
  searchHandouts,
  getHandout,
  searchChat,
} from "./tools/campaign.js";
import {
  ListPagesInput,
  GetPageInput,
  ListTokensInput,
  GetTokenInput,
  GetInitiativeInput,
  ListPlayersInput,
  listPages,
  getPage,
  listTokens,
  getToken,
  getInitiative,
  listPlayers,
} from "./tools/world.js";

// ─── Config ─────────────────────────────────────────────────────────────

const cfg = resolveConfig();
const DEFAULT_CHARACTER_ID = cfg.defaultCharacterId;
const PLAYER_ID = cfg.playerId;

const client = new FirebaseRestClient({
  databaseUrl: cfg.databaseUrl,
  idToken: cfg.idToken,
  campaignPath: cfg.campaignPath,
  defaultCharacterId: DEFAULT_CHARACTER_ID,
});

// ─── Tool registry ──────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  readOnly: boolean;
  handler: (input: unknown) => Promise<{ text: string; structuredContent?: unknown }>;
}

function tool<I extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  inputSchema: I;
  readOnly: boolean;
  handler: (input: z.infer<I>) => Promise<{ text: string; structuredContent?: unknown }>;
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    readOnly: def.readOnly,
    handler: (input: unknown) => def.handler(input as z.infer<I>),
  };
}

const ctx = { defaultCharacterId: DEFAULT_CHARACTER_ID, playerId: PLAYER_ID };

const TOOLS: ToolDef[] = [
  tool({
    name: "roll20_list_characters",
    description:
      "List characters in the campaign. Returns id, name, sheet type, and controllers.",
    inputSchema: ListCharactersInput,
    readOnly: true,
    handler: (input) => listCharacters(client, input, ctx),
  }),
  tool({
    name: "roll20_get_character_summary",
    description:
      "Get a one-screen summary of a character: name, species/class/subclass, level, current HP, sheet type. Defaults to the configured character.",
    inputSchema: CharacterIdInput,
    readOnly: true,
    handler: (input) => getCharacterSummary(client, input, ctx),
  }),
  tool({
    name: "roll20_get_combat_state",
    description:
      "Get current combat state for a character: HP / temp HP / death saves, remaining spell slots by level, pact slots, inspiration, and active conditions/exhaustion.",
    inputSchema: CharacterIdInput,
    readOnly: true,
    handler: (input) => getCombatState(client, input, ctx),
  }),
  tool({
    name: "roll20_list_spells",
    description:
      "List spells on a character's spellbook. Optional level filter (0=cantrip..9) and preparedOnly filter. Returns level, name, prepared status, school, ritual flag.",
    inputSchema: ListSpellsInput,
    readOnly: true,
    handler: (input) => listSpells(client, input, ctx),
  }),
  tool({
    name: "roll20_get_spell",
    description:
      "Get the full description and metadata for a single spell on the character — searches by name (case-insensitive substring) or exact UID.",
    inputSchema: GetSpellInput,
    readOnly: true,
    handler: (input) => getSpell(client, input, ctx),
  }),
  tool({
    name: "roll20_list_attacks",
    description:
      "List the character's attack actions (weapon attacks, spell attacks). Each entry includes name, action type, attack type, proficiency, and source.",
    inputSchema: CharacterIdInput,
    readOnly: true,
    handler: (input) => listAttacks(client, input, ctx),
  }),
  tool({
    name: "roll20_list_features",
    description:
      "List class features, feats, species traits, and other features on the character.",
    inputSchema: CharacterIdInput,
    readOnly: true,
    handler: (input) => listFeatures(client, input, ctx),
  }),
  tool({
    name: "roll20_get_inventory",
    description:
      "List inventory items (equipment + other possessions) for a character with quantity, equipped, and attunement flags.",
    inputSchema: CharacterIdInput,
    readOnly: true,
    handler: (input) => getInventory(client, input, ctx),
  }),
  tool({
    name: "roll20_get_currencies",
    description: "List currencies (cp/sp/gp/etc.) the character holds.",
    inputSchema: CharacterIdInput,
    readOnly: true,
    handler: (input) => getCurrencies(client, input, ctx),
  }),
  tool({
    name: "roll20_get_raw_attributes",
    description:
      "Universal fallback. Returns every attribute on a character as a flat name → {current, max} list. Works for any sheet type — use this for ogl5e NPCs (which the Beacon-specific tools can't read) or any time the structured tools are missing data. Supports nameFilter substring (e.g. 'hp', 'ac', 'repeating_npcaction') to keep responses small.",
    inputSchema: GetRawAttributesInput,
    readOnly: true,
    handler: (input) => getRawAttributes(client, input, ctx),
  }),
  tool({
    name: "roll20_search_handouts",
    description:
      "Search campaign handouts by name (or, with includeNotes=true, by body content). Returns id, name, tags. Use roll20_get_handout to read a specific handout's body.",
    inputSchema: SearchHandoutsInput,
    readOnly: true,
    handler: (input) => searchHandouts(client, input),
  }),
  tool({
    name: "roll20_get_handout",
    description:
      "Get a single handout's full body. Optionally include GM-only notes.",
    inputSchema: GetHandoutInput,
    readOnly: true,
    handler: (input) => getHandout(client, input),
  }),
  tool({
    name: "roll20_search_chat",
    description:
      "Search recent chat history. Filters by message type (general/rollresult/whisper/emote) and/or substring on `who`, content, or `origRoll`.",
    inputSchema: SearchChatInput,
    readOnly: true,
    handler: (input) => searchChat(client, input),
  }),
  // ─── world-tools registrations (added by apply_patch) ───
tool({
    name: "roll20_list_pages",
    description:
      "List pages (maps/scenes) in the campaign. Marks the active player page. Use to see what scene the players are looking at, or to find a pageId for list_tokens.",
    inputSchema: ListPagesInput,
    readOnly: true,
    handler: (input) => listPages(client, input),
  }),
  tool({
    name: "roll20_get_page",
    description:
      "Get full metadata for a single page: dimensions, grid, lighting, background. Use list_pages first to find pageId.",
    inputSchema: GetPageInput,
    readOnly: true,
    handler: (input) => getPage(client, input),
  }),
  tool({
    name: "roll20_list_tokens",
    description:
      "List tokens on a page. Defaults to the currently-active player page. Each token includes name, position (left/top), bar1/2/3 values (typically HP/AC/temp), status markers (poisoned/concentrating/etc.), and whether it represents a character. Filters: layer (objects/gmlayer/map), representsCharacterId, contains (name substring). USE THIS for combat awareness — 'who's on the battlefield, what HP do they have, what conditions are active'.",
    inputSchema: ListTokensInput,
    readOnly: true,
    handler: (input) => listTokens(client, input),
  }),
  tool({
    name: "roll20_get_token",
    description:
      "Get full detail for a single token (all bars, GM notes, controlledby, full position/rotation/dimensions). Use list_tokens first to find tokenId + pageId.",
    inputSchema: GetTokenInput,
    readOnly: true,
    handler: (input) => getToken(client, input),
  }),
  tool({
    name: "roll20_get_initiative",
    description:
      "Get the initiative tracker (turn order). Returns ordered list of entries with each token's name (looked up from the token's page) and initiative value. The first entry (▶) is whose turn it is. Empty if no encounter is active.",
    inputSchema: GetInitiativeInput,
    readOnly: true,
    handler: (input) => getInitiative(client, input),
  }),
  tool({
    name: "roll20_list_players",
    description:
      "List players in the campaign (display name, online status, last active timestamp, color, last page they viewed). Filter onlineOnly=true to see who's currently in the session. Useful for whisper-targeting and 'who's actually here right now'.",
    inputSchema: ListPlayersInput,
    readOnly: true,
    handler: (input) => listPlayers(client, input),
  }),
];

// ─── Server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "roll20-character-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

function toJsonSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  const json = zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>;
  // Strip wrapper noise; MCP expects an object schema.
  delete json.$schema;
  delete json.definitions;
  if (json.type !== "object") {
    return { type: "object", properties: {} } as Tool["inputSchema"];
  }
  return json as Tool["inputSchema"];
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.inputSchema),
    annotations: {
      readOnlyHint: t.readOnly,
      destructiveHint: false,
      idempotentHint: t.readOnly,
      openWorldHint: true,
    },
  }));
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const def = TOOLS.find((t) => t.name === req.params.name);
  if (!def) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const parsed = def.inputSchema.parse(req.params.arguments ?? {});
    const result = await def.handler(parsed);
    const content: { type: "text"; text: string }[] = [
      { type: "text", text: result.text },
    ];
    return {
      content,
      structuredContent: result.structuredContent,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const sources = [
    cfg.source.credentialFile ? "credential-file" : null,
    cfg.source.env ? "env" : null,
  ]
    .filter(Boolean)
    .join("+") || "(none)";
  console.error(
    `[roll20-mcp] up — ${TOOLS.length} tools, db=${cfg.databaseUrl}, campaign=${cfg.campaignPath}, config=${sources}` +
      (cfg.capturedAt ? `, captured=${cfg.capturedAt}` : ""),
  );
}

main().catch((e) => {
  console.error("[roll20-mcp] fatal:", e);
  process.exit(1);
});
