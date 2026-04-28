# Roll20 Character MCP Server

A read-only MCP server that exposes a Roll20 D&D 5e (2024 / Beacon) character sheet — and adjacent campaign data (handouts, chat) — directly from Roll20's Firebase Realtime Database. No browser automation, no DOM scraping, no Roll20 Pro subscription needed.

## What It Does

Roll20 stores live game state in Firebase RTDB. The web client authenticates via a session cookie, swaps it for a Firebase ID token, then reads/writes Firebase nodes over WebSocket. This server skips the WebSocket and the browser, going straight at Firebase REST with the same ID token. Reads are sub-second per subnode.

The Beacon engine (used by `dnd2024byroll20`) packs the entire sheet into a single 300+ KB nested-JSON blob — top-level state under `store.hitpoints`, `store.spellSlots`, etc., and every spell / attack / feature / item as an entry in `store.integrants.integrants` keyed by UID. This server decodes the double-encoded structure and exposes targeted tools that read just the nodes they need.

## Tools

| Tool | What it returns |
|------|-----------------|
| `roll20_list_characters` | All characters in the campaign. Filter by `controlledByMeOnly`. |
| `roll20_get_character_summary` | Name, species/class/subclass, level, current HP, sheet type. |
| `roll20_get_combat_state` | HP/temp/death saves, remaining spell slots by level, pact slots, inspiration, active conditions. |
| `roll20_list_spells` | Spellbook entries, with `level` and `preparedOnly` filters. |
| `roll20_get_spell` | Full description and metadata for one spell. |
| `roll20_list_attacks` | Weapon and spell attacks with action/attack types. |
| `roll20_list_features` | Class features, feats, species traits, other features. |
| `roll20_get_inventory` | Equipment + other possessions with quantity, equipped, attuned. |
| `roll20_get_currencies` | Currency holdings. |
| `roll20_search_handouts` | Substring search across handout names (and optionally bodies). |
| `roll20_get_handout` | Full handout body, optionally including GM notes. |
| `roll20_search_chat` | Recent chat messages, filterable by type and substring. |

All tools are `readOnlyHint: true`. Writes are deliberately not implemented in this version — Roll20's `store` blob has shape validators and an `updateId`/`sheetVersion` change-tracking pair that make blind writes risky. The intended workflow is: this MCP reads your sheet, applies rules knowledge from a separate Open5e MCP, and tells *you* what to edit in the Roll20 UI.

## Setup

```bash
npm install
npm run build
```

Then run with the four required env vars:

```bash
ROLL20_FIREBASE_DB_URL=https://roll20-99957.firebaseio.com \
ROLL20_FIREBASE_ID_TOKEN=<jwt> \
ROLL20_CAMPAIGN_PATH=campaign-NNN-XXXXXXXXXXXXXXXX \
ROLL20_DEFAULT_CHARACTER_ID=-OXXXXXXXXXXXXXXXXX \
ROLL20_PLAYER_ID=-OXXXXXXXXXXXXXXXXX \
node build/index.js
```

`ROLL20_DEFAULT_CHARACTER_ID` and `ROLL20_PLAYER_ID` are optional — without them, character-scoped tools require an explicit `characterId` argument.

## Getting the Config Values

Open your campaign editor in Chrome, open DevTools, paste this in the Console:

```js
(async () => {
  const u = firebase.auth().currentUser;
  console.log({
    ROLL20_FIREBASE_DB_URL: window.FIREBASE_ROOT.toString().replace(/\/$/, ""),
    ROLL20_FIREBASE_ID_TOKEN: await u.getIdToken(),
    ROLL20_CAMPAIGN_PATH: window.campaign_storage_path,
    ROLL20_PLAYER_ID: window.d20_player_id,
    // Find your character id from window.Campaign.characters
  });
})();
```

Find your character ID in the same console:

```js
window.Campaign.characters.models
  .filter(m => (m.get('controlledby') || '').includes(window.d20_player_id))
  .map(m => ({ id: m.id, name: m.get('name') }));
```

The ID token expires after about an hour. For now, refresh it manually when the server returns 401s.

## MCP Client Config

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "roll20-character": {
      "command": "node",
      "args": ["/Users/<you>/justin-mcp-servers/roll20-character-mcp-server/build/index.js"],
      "env": {
        "ROLL20_FIREBASE_DB_URL": "https://roll20-99957.firebaseio.com",
        "ROLL20_FIREBASE_ID_TOKEN": "...",
        "ROLL20_CAMPAIGN_PATH": "campaign-NNN-XXXXX",
        "ROLL20_DEFAULT_CHARACTER_ID": "-OXXXXX",
        "ROLL20_PLAYER_ID": "-OXXXXX"
      }
    }
  }
}
```

## Smoke Test

A standalone smoke harness that exercises every tool against live Firebase:

```bash
ROLL20_FIREBASE_DB_URL=... ROLL20_FIREBASE_ID_TOKEN=... \
ROLL20_CAMPAIGN_PATH=... ROLL20_DEFAULT_CHARACTER_ID=... \
ROLL20_PLAYER_ID=... node build/smoke.js
```

Or use the MCP Inspector for interactive testing:

```bash
ROLL20_FIREBASE_DB_URL=... [...] npm run inspector
```

## Architecture Notes

**Auth.** The Firebase ID token is a 1-hour JWT minted by `signInWithCustomToken` from a custom token Roll20 issues server-side from your session cookie. The roadmap is to integrate with [`mcp-auth-bridge`](../mcp-auth-bridge) — capture the Roll20 session cookie via Chrome extension, and have a small token-refresh service mint and refresh ID tokens as needed.

**Beacon vs. legacy sheets.** This server assumes the Beacon engine (`charactersheetname: dnd2024byroll20`). Legacy 5e sheets store data as flat `attribs` (hundreds of name/current/max rows) instead of one `store` blob. Adding a legacy code path would be straightforward — branch on `charactersheetname` in `getStore`.

**Max HP is computed, not stored.** Beacon stores 12+ "Hit Points" integrants per character (one per level) with `valueFormula` objects. Max HP is the runtime evaluation of those formulas. Tools here surface `currentHP` from `store.hitpoints`, which is what you actually need at the table; computed max is left for later.

**Path map.** A handful of read paths under `/{campaign}/`:
- `characters/{id}` — basic record (name, avatar, controlledby, charactersheetname)
- `char-attribs/char/{charId}/{attribId}` — sheet attributes; for Beacon, find the one named `store`
- `char-attribs/char/{charId}/{storeId}/current/<subnode>` — read individual subnodes (`hitpoints`, `spellSlots`, `integrants`, etc.)
- `handouts/{id}` — handouts
- `chat/{msgId}` — chat messages

Several paths return 401 (rules-restricted): `/char/{id}`, `/sheet-data`, the campaign root.

## Known Issues / Follow-ups

- `search_chat type=rollresult` filter currently misses recent rolls — the lexical sort of Firebase push IDs over the full ID list is the bottleneck; should switch to `orderBy=$key&limitToLast=N` REST params.
- `get_combat_state` reports "Exhaustion: active" when no exhaustion is present — the exhaustion integrant is always `_enabled` with level elsewhere; needs a level check.
- ID token expiry is unhandled. Add a 401-on-read → refresh path once we wire up the auth bridge.
- Writes are intentionally not implemented (see above).

## License

Private / personal use.
