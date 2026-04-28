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

Configuration is resolved in this order (later wins):

1. **`~/.mcp-credentials/roll20.json`** — written by [mcp-auth-bridge](https://github.com/justinritchie/mcp-auth-bridge) (recommended)
2. Environment variables — for CI / direct invocation

### Recommended: mcp-auth-bridge

Install [mcp-auth-bridge](https://github.com/justinritchie/mcp-auth-bridge) once. After that, every time your Roll20 ID token expires (~hourly), open the bridge popup while you have a Roll20 tab in front and click **Save Roll20**. It mints a fresh Firebase ID token, reads the campaign + player + character IDs from the page, and writes `~/.mcp-credentials/roll20.json`. The MCP server picks up the new file on the next tool call — no restart, no env-var juggling. This is what keeps your AI in the campaign while you're actually playing.

### Alternative: env vars

```bash
ROLL20_FIREBASE_DB_URL=https://roll20-99957.firebaseio.com \
ROLL20_FIREBASE_ID_TOKEN=<jwt> \
ROLL20_CAMPAIGN_PATH=campaign-NNN-XXXXXXXXXXXXXXXX \
ROLL20_DEFAULT_CHARACTER_ID=-OXXXXXXXXXXXXXXXXX \
ROLL20_PLAYER_ID=-OXXXXXXXXXXXXXXXXX \
node build/index.js
```

`ROLL20_DEFAULT_CHARACTER_ID` and `ROLL20_PLAYER_ID` are optional — without them, character-scoped tools require an explicit `characterId` argument.

To grab the values manually (one-time, if you don't want the bridge), open your campaign editor in Chrome, open DevTools, and paste this in the Console:

```js
(async () => {
  const u = firebase.auth().currentUser;
  console.log({
    ROLL20_FIREBASE_DB_URL: window.FIREBASE_ROOT.toString().replace(/\/$/, ""),
    ROLL20_FIREBASE_ID_TOKEN: await u.getIdToken(),
    ROLL20_CAMPAIGN_PATH: window.campaign_storage_path,
    ROLL20_PLAYER_ID: window.d20_player_id,
  });
})();
```

Find your character ID:

```js
window.Campaign.characters.models
  .filter(m => (m.get('controlledby') || '').includes(window.d20_player_id))
  .map(m => ({ id: m.id, name: m.get('name') }));
```

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

**Auth.** The Firebase ID token is a 1-hour JWT minted by `signInWithCustomToken` from a custom token Roll20 issues server-side from your session cookie. The server reads it from `~/.mcp-credentials/roll20.json`, written by [mcp-auth-bridge](https://github.com/justinritchie/mcp-auth-bridge) when you click **Save Roll20** in the popup. The bridge runs an on-demand script in the page's MAIN world that calls `firebase.auth().currentUser.getIdToken()` and reads `campaign_storage_path` / `d20_player_id` / `FIREBASE_ROOT` from window globals. Token expires hourly → click Save again. No code change in this server is needed when the credential file refreshes.

**Beacon vs. legacy sheets.** This server assumes the Beacon engine (`charactersheetname: dnd2024byroll20`). Legacy 5e sheets store data as flat `attribs` (hundreds of name/current/max rows) instead of one `store` blob. Adding a legacy code path would be straightforward — branch on `charactersheetname` in `getStore`.

**Max HP is computed, not stored.** Beacon stores 12+ "Hit Points" integrants per character (one per level) with `valueFormula` objects. Max HP is the runtime evaluation of those formulas. Tools here surface `currentHP` from `store.hitpoints`, which is what you actually need at the table; computed max is left for later.

**Path map.** A handful of read paths under `/{campaign}/`:
- `characters/{id}` — basic record (name, avatar, controlledby, charactersheetname)
- `char-attribs/char/{charId}/{attribId}` — sheet attributes; for Beacon, find the one named `store`
- `char-attribs/char/{charId}/{storeId}/current/<subnode>` — read individual subnodes (`hitpoints`, `spellSlots`, `integrants`, etc.)
- `handouts/{id}` — handouts
- `chat/{msgId}` — chat messages

Several paths return 401 (rules-restricted): `/char/{id}`, `/sheet-data`, the campaign root.

## Roadmap

**The point of this server is to let the AI play alongside you at the table.** That's why the auth path is designed for "click once at start of session, click again when the token expires" rather than "paste a fresh JWT into a config every hour."

**Done**
- 13 read tools covering character summary, combat state, spells, attacks, features, inventory, currencies, plus campaign-wide handouts and chat search.
- Beacon (D&D 2024 / `dnd2024byroll20`) sheet support with full integrant decoding.
- Legacy `ogl5e` fallback via `roll20_get_raw_attributes` — works on every sheet type, including DM-built NPCs.
- One-call bulk reads (campaign-wide listing in ~180ms; handout search in ~70ms).
- **mcp-auth-bridge integration** — `~/.mcp-credentials/roll20.json` is the canonical config source. Click Save Roll20 in the bridge popup whenever the token expires (hourly), and the MCP keeps reading without restart. This is what makes "the AI plays with you" actually viable — no friction, no env-var refreshes.

**Planned**
- Token-expiry detection in the MCP itself: when a Firebase REST call returns 401, surface a clean message ("token expired — click Save Roll20 in the bridge popup") instead of opaque errors.
- Computed max-HP for Beacon characters (currently only `currentHP` is surfaced; max is derived from the per-level Hit Points integrant formulas).
- Tighter conditions/exhaustion filtering in `get_combat_state` (the exhaustion integrant is always `_enabled` regardless of level).
- An optional companion read tool tuned for NPC stat blocks on legacy sheets — wraps the raw-attribute reader with hand-picked fields (HP/AC/saves/known spells/repeating actions) so the LLM doesn't have to navigate the flat-attrib graveyard.
- Open5e MCP companion server (separate repo) — the AI reads your sheet here, looks up rules there.

**Out of scope (deliberately)**
- Writes. The Beacon `store` blob has shape validators and an `updateId`/`sheetVersion` change-tracking pair; blind writes risk bricking the sheet. The intended workflow is "MCP reads, AI advises, you click in Roll20."

## License

Private / personal use.
