/**
 * Character read tools.
 *
 * Each tool returns BOTH a structured payload (for downstream code/logic) and
 * a short text summary (so the LLM gets a usable answer immediately without
 * needing to parse the JSON).
 */

import { z } from "zod";
import type { FirebaseRestClient, CharacterRecord } from "../client.js";
import { slotLevelFromIndex, slotLevelToOrdinal, type SlotLevel, type Integrant } from "../decode.js";

// ─── Shared schemas ─────────────────────────────────────────────────────

export const CharacterIdInput = z.object({
  characterId: z
    .string()
    .optional()
    .describe(
      "Roll20 character UID. Optional — defaults to ROLL20_DEFAULT_CHARACTER_ID env var.",
    ),
});
export type CharacterIdInput = z.infer<typeof CharacterIdInput>;

function resolveCharacterId(
  input: CharacterIdInput,
  fallback: string | undefined,
): string {
  const id = input.characterId ?? fallback;
  if (!id) {
    throw new Error(
      "No characterId provided and ROLL20_DEFAULT_CHARACTER_ID is not set.",
    );
  }
  return id;
}

// ─── list_characters ────────────────────────────────────────────────────

export const ListCharactersInput = z.object({
  controlledByMeOnly: z
    .boolean()
    .optional()
    .describe(
      "If true, only return characters whose `controlledby` field includes the configured player id (env ROLL20_PLAYER_ID).",
    ),
});

export async function listCharacters(
  client: FirebaseRestClient,
  input: z.infer<typeof ListCharactersInput>,
  ctx: { playerId?: string },
): Promise<{
  text: string;
  structuredContent: { characters: CharacterRecord[] };
}> {
  let chars = await client.listCharacters();
  if (input.controlledByMeOnly && ctx.playerId) {
    chars = chars.filter((c) => (c.controlledby ?? "").includes(ctx.playerId!));
  }
  const text = chars
    .map((c) => `• ${c.name} — id ${c.id}${c.charactersheetname ? ` (sheet ${c.charactersheetname})` : ""}${c.controlledby ? ` [controlledby ${c.controlledby}]` : ""}`)
    .join("\n");
  return {
    text: chars.length ? text : "(no characters)",
    structuredContent: { characters: chars },
  };
}

// ─── get_character_summary ──────────────────────────────────────────────

export async function getCharacterSummary(
  client: FirebaseRestClient,
  input: CharacterIdInput,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const rec = await client.getCharacterRecord(id);
  if (!rec) throw new Error(`Character not found: ${id}`);
  const integrants = await client.getIntegrants(id);
  const ints = Object.values(integrants);

  const cls = ints.find((i) => i.type === "Class");
  const subclass = ints.find((i) => i.type === "Subclass");
  const species = ints.find((i) => i.type === "Species");
  const background = ints.find((i) => i.type === "Background");
  const classLevels = ints.filter((i) => i.type === "Class Level");
  const totalLevel = classLevels.length;

  const hp = await client.getHitpoints(id);

  const summary = {
    id: rec.id,
    name: rec.name,
    sheet: rec.charactersheetname,
    controlledBy: rec.controlledby,
    species: species?.name,
    class: cls?.name,
    subclass: subclass?.name,
    background: background?.name,
    totalLevel,
    currentHP: hp?.currentHP,
    tempHP: hp?.tempHP,
  };
  const text = [
    `${rec.name} (${rec.id})`,
    summary.species && summary.class
      ? `${summary.species} ${summary.class}${summary.subclass ? " (" + summary.subclass + ")" : ""}, level ${summary.totalLevel}`
      : `level ${summary.totalLevel}`,
    summary.background ? `Background: ${summary.background}` : null,
    hp ? `HP ${hp.currentHP}${hp.tempHP ? ` (+${hp.tempHP} temp)` : ""}` : null,
    `Sheet: ${rec.charactersheetname ?? "(unknown)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { text, structuredContent: summary };
}

// ─── get_combat_state ───────────────────────────────────────────────────

export async function getCombatState(
  client: FirebaseRestClient,
  input: CharacterIdInput,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const [hp, slots, inspiration, integrants] = await Promise.all([
    client.getHitpoints(id),
    client.getSpellSlots(id),
    client.getStoreSubnode<{ isInspired?: boolean }>(id, "inspiration"),
    client.getIntegrants(id),
  ]);

  const ints = Object.values(integrants);
  const activeConditions = ints
    .filter((i) => i.type === "Condition" && i._enabled === true && (i._label ?? "") !== "")
    .map((i) => i._label || i.name)
    .filter(Boolean);
  const activeExhaustion = ints.find((i) => i.type === "Exhaustion" && i._enabled);

  const slotLines: string[] = [];
  if (slots) {
    for (let lvl = 1; lvl <= 9; lvl++) {
      const key = slotLevelFromIndex(lvl) as SlotLevel;
      const remaining = slots.currentByLevel?.[key] ?? 0;
      if (remaining > 0) slotLines.push(`L${lvl}: ${remaining}`);
    }
    const pact = Object.entries(slots.currentPactByLevel ?? {})
      .filter(([, n]) => (n as number) > 0)
      .map(([k, n]) => `pact ${k.toLowerCase()}: ${n}`);
    slotLines.push(...pact);
  }

  const text = [
    hp ? `HP ${hp.currentHP}${hp.tempHP ? ` (+${hp.tempHP} temp)` : ""}; deaths ${hp.deathSaves.successes}↑/${hp.deathSaves.failures}↓` : null,
    slotLines.length ? `Slots remaining — ${slotLines.join(", ")}` : "No spell slots remaining",
    inspiration?.isInspired ? "Inspired" : null,
    activeConditions.length ? `Conditions: ${activeConditions.join(", ")}` : null,
    activeExhaustion ? `Exhaustion: ${activeExhaustion._label || "active"}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text,
    structuredContent: {
      hitpoints: hp,
      spellSlotsRemaining: slots?.currentByLevel,
      pactSlotsRemaining: slots?.currentPactByLevel,
      inspired: inspiration?.isInspired ?? false,
      activeConditions,
    },
  };
}

// ─── list_spells ────────────────────────────────────────────────────────

export const ListSpellsInput = CharacterIdInput.extend({
  level: z
    .number()
    .int()
    .min(0)
    .max(9)
    .optional()
    .describe("Spell level filter (0 = cantrip, 1..9). Omit for all levels."),
  preparedOnly: z
    .boolean()
    .optional()
    .describe("If true, only return prepared (or always-prepared) spells."),
});

export async function listSpells(
  client: FirebaseRestClient,
  input: z.infer<typeof ListSpellsInput>,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const [grid, integrants] = await Promise.all([
    client.getSpellsDisplayOrder(id),
    client.getIntegrants(id),
  ]);

  const rows: {
    level: number;
    name: string;
    uid: string;
    school?: string;
    prepared: boolean;
    alwaysPrepared: boolean;
    castingTime?: string;
    range?: string;
    ritual?: boolean;
  }[] = [];

  grid.forEach((uids, level) => {
    if (input.level !== undefined && input.level !== level) return;
    for (const uid of uids) {
      const sp = integrants[uid];
      if (!sp || sp.type !== "Spell") continue;
      const prepared = !!sp._prepared || !!sp.alwaysPrepared;
      if (input.preparedOnly && !prepared) continue;
      rows.push({
        level,
        name: sp.name ?? "(unnamed)",
        uid,
        school: sp.school,
        prepared,
        alwaysPrepared: !!sp.alwaysPrepared,
        castingTime: sp.castingTime,
        range: sp.range,
        ritual: !!sp.ritual,
      });
    }
  });

  const groupedText = [...new Set(rows.map((r) => r.level))]
    .sort((a, b) => a - b)
    .map((lvl) => {
      const ofLvl = rows
        .filter((r) => r.level === lvl)
        .map((r) => {
          const tags = [
            r.alwaysPrepared ? "always" : r.prepared ? "prepared" : "unprepared",
            r.ritual ? "ritual" : null,
            r.school,
          ]
            .filter(Boolean)
            .join(", ");
          return `  • ${r.name} [${tags}]`;
        })
        .join("\n");
      return `Level ${lvl === 0 ? "0 (cantrips)" : lvl}\n${ofLvl}`;
    })
    .join("\n\n");

  return {
    text: rows.length ? groupedText : "(no spells match)",
    structuredContent: { spells: rows },
  };
}

// ─── get_spell ──────────────────────────────────────────────────────────

export const GetSpellInput = CharacterIdInput.extend({
  query: z
    .string()
    .describe("Spell name (case-insensitive substring) or exact integrant UID."),
});

export async function getSpell(
  client: FirebaseRestClient,
  input: z.infer<typeof GetSpellInput>,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const integrants = await client.getIntegrants(id);
  let sp: Integrant | undefined = integrants[input.query];
  if (!sp || sp.type !== "Spell") {
    const q = input.query.toLowerCase();
    sp = Object.values(integrants).find(
      (i) => i.type === "Spell" && (i.name ?? "").toLowerCase().includes(q),
    );
  }
  if (!sp) {
    return {
      text: `No spell matching "${input.query}".`,
      structuredContent: { found: false },
    };
  }
  const text = [
    `${sp.name} (level ${sp.level ?? "?"} ${sp.school ?? ""})`.trim(),
    sp.castingTime ? `Casting: ${sp.castingTime}` : null,
    sp.range ? `Range: ${sp.range}` : null,
    sp.duration ? `Duration: ${sp.duration}` : null,
    sp.components
      ? `Components: ${[
          sp.components.verbal && "V",
          sp.components.somatic && "S",
          sp.components.material && `M (${sp.components.materialDescription ?? "unspecified"})`,
        ]
          .filter(Boolean)
          .join(", ")}`
      : null,
    sp._prepared || sp.alwaysPrepared
      ? sp.alwaysPrepared
        ? "Always prepared"
        : "Prepared"
      : "Not prepared",
    sp.description ? `\n${sp.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { text, structuredContent: sp };
}

// ─── list_attacks ───────────────────────────────────────────────────────

export async function listAttacks(
  client: FirebaseRestClient,
  input: CharacterIdInput,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const [order, integrants] = await Promise.all([
    client.getAttacksDisplayOrder(id),
    client.getIntegrants(id),
  ]);
  const rows = order
    .map((uid) => integrants[uid])
    .filter((i) => i && i.type === "Attack")
    .map((i) => ({
      name: i.name,
      attackType: i.attack?.type,
      proficiency: i.attack?.proficiencyLevel,
      actionType: i.actionType,
      source: i.source,
      sourceID: i.sourceID,
    }));
  const text = rows.map((r) => `• ${r.name} [${r.actionType ?? "?"}, ${r.attackType ?? "?"}, ${r.proficiency ?? "?"}]${r.source ? ` from ${r.source}` : ""}`).join("\n");
  return { text: text || "(no attacks)", structuredContent: { attacks: rows } };
}

// ─── list_features ──────────────────────────────────────────────────────

export async function listFeatures(
  client: FirebaseRestClient,
  input: CharacterIdInput,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const [orders, integrants] = await Promise.all([
    client.getFeaturesDisplayOrders(id),
    client.getIntegrants(id),
  ]);
  const expand = (uids: string[], category: string) =>
    uids
      .map((uid) => integrants[uid])
      .filter(Boolean)
      .map((i) => ({
        category,
        name: i.name ?? "(unnamed)",
        source: i.source,
        enabled: i._enabled !== false,
      }));
  const rows = [
    ...expand(orders.classFeatures, "class"),
    ...expand(orders.feats, "feat"),
    ...expand(orders.speciesTraits, "species"),
    ...expand(orders.other, "other"),
  ];
  const text = rows
    .map((r) => `• [${r.category}] ${r.name}${r.source ? ` — ${r.source}` : ""}${r.enabled ? "" : " (disabled)"}`)
    .join("\n");
  return { text: text || "(no features)", structuredContent: { features: rows } };
}

// ─── get_inventory ──────────────────────────────────────────────────────

export async function getInventory(
  client: FirebaseRestClient,
  input: CharacterIdInput,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const [orders, integrants] = await Promise.all([
    client.getInventoryDisplayOrders(id),
    client.getIntegrants(id),
  ]);
  const expand = (uids: string[], category: string) =>
    uids
      .map((uid) => integrants[uid])
      .filter(Boolean)
      .map((i) => ({
        category,
        name: i.name ?? "(unnamed)",
        equipped: i._enabled !== false,
        attuned: !!i.attuned,
        quantity: (i.quantity as number) ?? 1,
        weight: (i.weight as number) ?? null,
      }));
  const rows = [
    ...expand(orders.equipment, "equipment"),
    ...expand(orders.other, "other"),
  ];
  const text = rows
    .map((r) => `• [${r.category}] ${r.name} ×${r.quantity}${r.equipped ? " (equipped)" : ""}${r.attuned ? " ATTUNED" : ""}`)
    .join("\n");
  return { text: text || "(no inventory)", structuredContent: { inventory: rows } };
}

// ─── get_currencies ─────────────────────────────────────────────────────

export async function getCurrencies(
  client: FirebaseRestClient,
  input: CharacterIdInput,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const integrants = await client.getIntegrants(id);
  const rows = Object.values(integrants)
    .filter((i) => i.type === "Currency")
    .map((i) => ({
      name: i.name,
      amount: (i.amount as number) ?? null,
      shortID: i.shortID,
    }));
  const text = rows.map((r) => `• ${r.name}: ${r.amount ?? "?"}`).join("\n");
  return { text: text || "(no currencies)", structuredContent: { currencies: rows } };
}

// ─── get_raw_attributes (universal fallback) ────────────────────────────

export const GetRawAttributesInput = CharacterIdInput.extend({
  nameFilter: z
    .string()
    .optional()
    .describe(
      "Case-insensitive substring filter on attribute name. Example: 'hp', 'ac', 'repeating_npcaction'.",
    ),
  includeStore: z
    .boolean()
    .optional()
    .describe(
      "If true, include the (large) Beacon `store` attribute. Default false to keep responses small.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe("Max attributes to return (default 500)."),
});

export async function getRawAttributes(
  client: FirebaseRestClient,
  input: z.infer<typeof GetRawAttributesInput>,
  ctx: { defaultCharacterId?: string },
) {
  const id = resolveCharacterId(input, ctx.defaultCharacterId);
  const limit = input.limit ?? 500;
  const filter = input.nameFilter?.toLowerCase();
  const all = await client.getAllAttributes(id);

  const filtered = all.filter((a) => {
    if (!input.includeStore && a.name === "store") return false;
    if (filter && !a.name.toLowerCase().includes(filter)) return false;
    return true;
  });
  const truncated = filtered.length > limit;
  const rows = filtered.slice(0, limit);

  const text = rows
    .map((a) => {
      const cur = renderAttrValue(a.current);
      const mx = a.max != null && a.max !== "" ? ` / ${renderAttrValue(a.max)}` : "";
      return `• ${a.name || "(unnamed)"}: ${cur}${mx}`;
    })
    .join("\n");
  const summary = `${rows.length} of ${all.length} attributes${filter ? ` matching "${input.nameFilter}"` : ""}${truncated ? " (truncated — raise `limit` or narrow `nameFilter`)" : ""}`;

  return {
    text: `${summary}\n\n${text || "(no matches)"}`,
    structuredContent: {
      characterId: id,
      total: all.length,
      returned: rows.length,
      truncated,
      attributes: rows,
    },
  };
}

function renderAttrValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    if (v.length > 200) return v.slice(0, 200) + `…(${v.length} chars)`;
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Object — likely the Beacon store; render compact
  const s = JSON.stringify(v);
  return s.length > 200 ? s.slice(0, 200) + `…(${s.length} chars)` : s;
}

export { slotLevelToOrdinal };
