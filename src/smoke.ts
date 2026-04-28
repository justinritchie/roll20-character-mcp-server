/**
 * End-to-end smoke test against live Roll20.
 *
 * Exercises a few representative tools through the same code paths the MCP
 * server uses, but bypassing the JSON-RPC layer for clearer error reporting.
 *
 * Run:
 *   ROLL20_FIREBASE_DB_URL=... \
 *   ROLL20_FIREBASE_ID_TOKEN=... \
 *   ROLL20_CAMPAIGN_PATH=... \
 *   ROLL20_DEFAULT_CHARACTER_ID=... \
 *   ROLL20_PLAYER_ID=... \
 *   node build/smoke.js
 */

import { FirebaseRestClient } from "./client.js";
import {
  getCharacterSummary,
  getCombatState,
  listSpells,
  getSpell,
  listAttacks,
  listFeatures,
  getInventory,
  listCharacters,
  getRawAttributes,
} from "./tools/character.js";
import { searchHandouts, searchChat } from "./tools/campaign.js";

function need(n: string): string {
  const v = process.env[n];
  if (!v) {
    console.error(`missing env ${n}`);
    process.exit(1);
  }
  return v;
}

async function run() {
  const client = new FirebaseRestClient({
    databaseUrl: need("ROLL20_FIREBASE_DB_URL"),
    idToken: need("ROLL20_FIREBASE_ID_TOKEN"),
    campaignPath: need("ROLL20_CAMPAIGN_PATH"),
    defaultCharacterId: process.env.ROLL20_DEFAULT_CHARACTER_ID,
  });
  const ctx = {
    defaultCharacterId: process.env.ROLL20_DEFAULT_CHARACTER_ID,
    playerId: process.env.ROLL20_PLAYER_ID,
  };

  const heading = (s: string) => console.log("\n=== " + s + " ===");

  heading("get_character_summary");
  console.log((await getCharacterSummary(client, {}, ctx)).text);

  heading("get_combat_state");
  console.log((await getCombatState(client, {}, ctx)).text);

  heading("list_spells (preparedOnly, level=3)");
  console.log(
    (await listSpells(client, { level: 3, preparedOnly: true }, ctx)).text,
  );

  heading('get_spell ("fireball" or first prepared 3rd-level)');
  // Try a generic 3rd-level spell name lookup
  console.log((await getSpell(client, { query: "fire" }, ctx)).text.slice(0, 600));

  heading("list_attacks");
  console.log((await listAttacks(client, {}, ctx)).text.slice(0, 1200));

  heading("list_features");
  console.log((await listFeatures(client, {}, ctx)).text.slice(0, 1200));

  heading("get_inventory");
  console.log((await getInventory(client, {}, ctx)).text.slice(0, 1200));

  heading("list_characters (controlledByMeOnly)");
  console.log(
    (await listCharacters(client, { controlledByMeOnly: true }, ctx)).text,
  );

  const handoutQuery = process.env.ROLL20_SMOKE_HANDOUT_QUERY ?? "map";
  heading(`search_handouts ("${handoutQuery}")`);
  console.log((await searchHandouts(client, { query: handoutQuery, limit: 5 })).text);

  heading('search_chat (recent 30, type=rollresult)');
  console.log(
    (await searchChat(client, { recent: 30, type: "rollresult" })).text.slice(0, 1500),
  );

  // Fallback test: read a non-Beacon (legacy ogl5e) character via raw attributes.
  // Set ROLL20_SMOKE_NPC_ID to a non-Beacon character UID to enable.
  const npcId = process.env.ROLL20_SMOKE_NPC_ID;
  if (npcId) {
    heading(`get_raw_attributes (${npcId}, nameFilter="hp")`);
    console.log(
      (await getRawAttributes(
        client,
        { characterId: npcId, nameFilter: "hp", limit: 30 },
        ctx,
      )).text,
    );

    heading(`get_raw_attributes (${npcId}, nameFilter="npc_ac")`);
    console.log(
      (await getRawAttributes(
        client,
        { characterId: npcId, nameFilter: "npc_ac", limit: 10 },
        ctx,
      )).text,
    );
  }

  console.log("\n[smoke] done");
}

run().catch((e) => {
  console.error("[smoke] FAIL:", e);
  process.exit(1);
});
