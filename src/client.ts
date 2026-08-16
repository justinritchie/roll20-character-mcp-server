/**
 * Roll20 Firebase Realtime Database REST client.
 *
 * Roll20 stores live campaign state in Firebase RTDB. Reads are authenticated
 * with a Firebase ID token (a JWT, ~900 chars, default 1-hour TTL). The token
 * is minted by Firebase when the Roll20 web client calls
 * `signInWithCustomToken` with a custom token Roll20 issues from the user's
 * session cookie.
 *
 * For now this client takes the ID token as input — the user grabs it once
 * from DevTools (`firebase.auth().currentUser.getIdToken()`) and passes it via
 * env. A follow-up will integrate with mcp-auth-bridge to refresh automatically.
 */

import {
  decode,
  decodePath,
  decodeDisplayOrder,
  decodeDisplayOrderGrid,
  type BeaconStore,
  type Hitpoints,
  type SpellSlots,
  type Integrant,
} from "./decode.js";

export interface ClientConfig {
  /** Firebase RTDB base URL, e.g. https://roll20-99957.firebaseio.com */
  databaseUrl: string;
  /** Firebase ID token (JWT). Expires ~1h. */
  idToken: string;
  /** Campaign storage path, e.g. campaign-NNNNNNNN-XXXXXXXXXXXXXXXXXXXXXX */
  campaignPath: string;
  /** Default character ID for character-scoped tools. */
  defaultCharacterId?: string;
}

export interface CharacterRecord {
  id: string;
  name: string;
  avatar?: string;
  charactersheetname?: string;
  controlledby?: string;
  inplayerjournals?: string;
  defaulttoken?: number;
  description?: string;
  tags?: string;
  character_type?: string;
  custom_meta1?: string;
  custom_meta2?: string;
  custom_meta3?: string;
}

export interface Handout {
  id: string;
  name: string;
  notes?: string;
  gmnotes?: string;
  avatar?: string;
  tags?: string;
  inplayerjournals?: string;
  archived?: boolean;
}

export interface RawAttribute {
  id: string;
  name: string;
  /** May be a string, number, boolean, or pre-parsed object (Beacon `store`). */
  current: unknown;
  max: unknown;
}

export interface ChatMessage {
  who: string;
  playerid?: string;
  content: string;
  origRoll?: string;
  type: string;
  timestamp: number;
  avatar?: string;
  signature?: string;
}

export class Roll20RestError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`Roll20 Firebase REST ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "Roll20RestError";
  }
}

export class FirebaseRestClient {
  constructor(private cfg: ClientConfig) {}

  /** Low-level GET. Returns parsed JSON. Throws on non-200. */
  async get<T = unknown>(path: string, params: Record<string, string> = {}): Promise<T> {
    const cleanPath = path.replace(/^\/+/, "");
    const url = new URL(`${this.cfg.databaseUrl.replace(/\/$/, "")}/${cleanPath}.json`);
    url.searchParams.set("auth", this.cfg.idToken);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url.toString());
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Roll20RestError(r.status, cleanPath, body);
    }
    return (await r.json()) as T;
  }

  // ─── Campaign-scoped helpers ───────────────────────────────────────────

  campaignPath(...rest: string[]): string {
    return [this.cfg.campaignPath, ...rest].join("/");
  }

  // ─── Character ─────────────────────────────────────────────────────────

  /** List all characters (basic record only — no sheet data). One REST call. */
  async listCharacters(): Promise<CharacterRecord[]> {
    const all = await this.get<Record<string, CharacterRecord> | null>(
      this.campaignPath("characters"),
    );
    if (!all) return [];
    return Object.entries(all).map(([id, rec]) => ({ ...rec, id }));
  }

  async getCharacterRecord(charId: string): Promise<CharacterRecord | null> {
    try {
      const r = await this.get<CharacterRecord>(this.campaignPath("characters", charId));
      return r ? { ...r, id: charId } : null;
    } catch (e) {
      if (e instanceof Roll20RestError && e.status === 401) return null;
      throw e;
    }
  }

  /**
   * Find the attribute-bag id holding the `store` blob for a Beacon character.
   * Beacon sheets have a small set of attribs (~5); we cache the store id.
   */
  private storeIdCache = new Map<string, string>();

  async findStoreId(charId: string): Promise<string | null> {
    const cached = this.storeIdCache.get(charId);
    if (cached) return cached;
    const ids = await this.get<Record<string, true>>(
      this.campaignPath("char-attribs", "char", charId),
      { shallow: "true" },
    );
    if (!ids) return null;
    for (const id of Object.keys(ids)) {
      const attr = await this.get<{ name?: string }>(
        this.campaignPath("char-attribs", "char", charId, id),
      );
      if (attr && attr.name === "store") {
        this.storeIdCache.set(charId, id);
        return id;
      }
    }
    return null;
  }

  /** Read the full Beacon `store` blob for a character. */
  async getStore(charId: string): Promise<BeaconStore | null> {
    const storeId = await this.findStoreId(charId);
    if (!storeId) return null;
    const cur = await this.get<unknown>(
      this.campaignPath("char-attribs", "char", charId, storeId, "current"),
    );
    return decode<BeaconStore>(cur);
  }

  /** Read just one subnode of the store (efficient — small payload). */
  async getStoreSubnode<T = unknown>(charId: string, ...subpath: string[]): Promise<T | undefined> {
    const storeId = await this.findStoreId(charId);
    if (!storeId) return undefined;
    const raw = await this.get<unknown>(
      this.campaignPath("char-attribs", "char", charId, storeId, "current", ...subpath),
    );
    return decode<T>(raw);
  }

  async getHitpoints(charId: string): Promise<Hitpoints | undefined> {
    return this.getStoreSubnode<Hitpoints>(charId, "hitpoints");
  }

  async getSpellSlots(charId: string): Promise<SpellSlots | undefined> {
    return this.getStoreSubnode<SpellSlots>(charId, "spellSlots");
  }

  async getIntegrants(charId: string): Promise<Record<string, Integrant>> {
    const blob = await this.getStoreSubnode<{ integrants?: Record<string, Integrant> }>(
      charId,
      "integrants",
    );
    return blob?.integrants ?? {};
  }

  async getSpellsDisplayOrder(charId: string): Promise<string[][]> {
    const spells = await this.getStoreSubnode<unknown>(charId, "spells");
    if (!spells || typeof spells !== "object") return [];
    const raw = (spells as { displayOrder?: unknown }).displayOrder;
    return decodeDisplayOrderGrid(raw);
  }

  async getAttacksDisplayOrder(charId: string): Promise<string[]> {
    const attacks = await this.getStoreSubnode<unknown>(charId, "attacks");
    if (!attacks || typeof attacks !== "object") return [];
    return decodeDisplayOrder((attacks as { attackDisplayOrder?: unknown }).attackDisplayOrder);
  }

  async getFeaturesDisplayOrders(charId: string): Promise<{
    classFeatures: string[];
    feats: string[];
    other: string[];
    speciesTraits: string[];
  }> {
    const f = await this.getStoreSubnode<Record<string, unknown>>(charId, "features");
    return {
      classFeatures: decodeDisplayOrder(f?.classFeatureDisplayOrder),
      feats: decodeDisplayOrder(f?.featsDisplayOrder),
      other: decodeDisplayOrder(f?.otherDisplayOrder),
      speciesTraits: decodeDisplayOrder(f?.speciesTraitsDisplayOrder),
    };
  }

  async getInventoryDisplayOrders(charId: string): Promise<{
    equipment: string[];
    other: string[];
  }> {
    const inv = await this.getStoreSubnode<Record<string, unknown>>(charId, "inventory");
    return {
      equipment: decodeDisplayOrder(inv?.equipmentDisplayOrder),
      other: decodeDisplayOrder(inv?.otherPossessionsDisplayOrder),
    };
  }

  // ─── Raw attribute access (fallback for legacy sheets) ────────────────

  /**
   * Read every attribute on a character as a flat name → {current, max} map.
   * Works for any sheet type (Beacon, ogl5e, custom). For Beacon characters
   * this is mostly the `store` blob plus a few meta fields. For ogl5e NPCs
   * this is hundreds of flat fields (`hp`, `npc_ac`, `repeating_npcaction_$0_*`,
   * etc.) that the dedicated Beacon tools can't surface.
   */
  async getAllAttributes(charId: string): Promise<RawAttribute[]> {
    // Single REST call returning the entire attrib bag — much faster than
    // per-row fetches for legacy sheets with hundreds of attributes.
    const bag = await this.get<Record<string, { name?: string; current?: unknown; max?: unknown }> | null>(
      this.campaignPath("char-attribs", "char", charId),
    );
    if (!bag) return [];
    const out: RawAttribute[] = [];
    for (const [id, a] of Object.entries(bag)) {
      if (!a) continue;
      out.push({
        id,
        name: typeof a.name === "string" ? a.name : "",
        current: a.current,
        max: a.max,
      });
    }
    return out;
  }

  // ─── Handouts ──────────────────────────────────────────────────────────

  async listHandoutIds(): Promise<string[]> {
    const ids = await this.get<Record<string, true>>(
      this.campaignPath("handouts"),
      { shallow: "true" },
    );
    return Object.keys(ids ?? {});
  }

  async getHandout(handoutId: string): Promise<Handout | null> {
    try {
      const h = await this.get<Handout>(this.campaignPath("handouts", handoutId));
      return h ? { ...h, id: handoutId } : null;
    } catch (e) {
      if (e instanceof Roll20RestError && e.status === 401) return null;
      throw e;
    }
  }

  /**
   * Search handouts by name substring. Single REST call — bulk reads the
   * entire handouts collection and filters client-side. For typical campaigns
   * (hundreds of handouts) this is dramatically faster than per-handout
   * fetches, even though the response is larger.
   */
  async searchHandouts(
    query: string,
    opts: { limit?: number; includeNotes?: boolean } = {},
  ): Promise<Handout[]> {
    const q = query.toLowerCase();
    const limit = opts.limit ?? 20;
    const all = await this.get<Record<string, Handout> | null>(
      this.campaignPath("handouts"),
    );
    if (!all) return [];
    const matches: Handout[] = [];
    const asStr = (v: unknown) => (typeof v === "string" ? v : "");
    for (const [id, h] of Object.entries(all)) {
      if (!h || !h.name) continue;
      const nameMatch = asStr(h.name).toLowerCase().includes(q);
      const notesMatch = !!opts.includeNotes && asStr(h.notes).toLowerCase().includes(q);
      if (nameMatch || notesMatch) {
        matches.push({ ...h, id });
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }

  // ─── Chat ──────────────────────────────────────────────────────────────

  async listChatMessageIds(): Promise<string[]> {
    const ids = await this.get<Record<string, true>>(
      this.campaignPath("chat"),
      { shallow: "true" },
    );
    return Object.keys(ids ?? {});
  }

  async getChatMessage(msgId: string): Promise<ChatMessage | null> {
    try {
      return await this.get<ChatMessage>(this.campaignPath("chat", msgId));
    } catch (e) {
      if (e instanceof Roll20RestError && e.status === 401) return null;
      throw e;
    }
  }

  /**
   * Fetch the most recent N chat messages. Uses Firebase REST's
   * orderBy="$key" + limitToLast to pull only the recent slice in one call —
   * push IDs sort lexically by creation time, so this returns true newest-N.
   */
  async getRecentChat(limit = 50): Promise<ChatMessage[]> {
    const map = await this.get<Record<string, ChatMessage> | null>(
      this.campaignPath("chat"),
      { orderBy: '"$key"', limitToLast: String(limit) },
    );
    if (!map) return [];
    // Sort newest-first by timestamp (push IDs are creation-ordered, but
    // timestamp is more reliable for the surface contract).
    const arr = Object.values(map);
    arr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return arr;
  }

  // ─── world-tools methods (added by apply_patch) ───
// ─── Pages ─────────────────────────────────────────────────────────────

  /** List all pages in the campaign. Single REST call. */
  async listPages(): Promise<PageRecord[]> {
    const all = await this.get<Record<string, PageRecord> | null>(
      this.campaignPath("pages"),
    );
    if (!all) return [];
    return Object.entries(all).map(([id, rec]) => ({ ...rec, id }));
  }

  async getPage(pageId: string): Promise<PageRecord | null> {
    try {
      const r = await this.get<PageRecord>(this.campaignPath("pages", pageId));
      return r ? { ...r, id: pageId } : null;
    } catch (e) {
      if (e instanceof Roll20RestError && e.status === 401) return null;
      throw e;
    }
  }

  /** Read the active player-facing page id from campaign settings. */
  async getActivePageId(): Promise<string | null> {
    try {
      // Roll20 stores this on the /campaign root as `playerpageid`
      const v = await this.get<string | null>(
        this.campaignPath("campaign", "playerpageid"),
      );
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }

  // ─── Tokens (page-scoped) ──────────────────────────────────────────────

  /** List tokens on a page. Tokens live under pages/<pageId>/objgraphic.
   *  We tag each with page_id for downstream context. */
  async listTokens(pageId: string): Promise<TokenRecord[]> {
    const all = await this.get<Record<string, TokenRecord> | null>(
      this.campaignPath("pages", pageId, "objgraphic"),
    );
    if (!all) return [];
    return Object.entries(all).map(([id, rec]) => ({
      ...rec,
      id,
      page_id: pageId,
    }));
  }

  async getToken(pageId: string, tokenId: string): Promise<TokenRecord | null> {
    try {
      const r = await this.get<TokenRecord>(
        this.campaignPath("pages", pageId, "objgraphic", tokenId),
      );
      return r ? { ...r, id: tokenId, page_id: pageId } : null;
    } catch (e) {
      if (e instanceof Roll20RestError && e.status === 401) return null;
      throw e;
    }
  }

  // ─── Initiative tracker ────────────────────────────────────────────────

  /** Read the campaign turnorder. Stored as a JSON string at /campaign/turnorder. */
  async getInitiative(): Promise<InitiativeEntry[]> {
    try {
      const raw = await this.get<string | null>(
        this.campaignPath("campaign", "turnorder"),
      );
      if (!raw || typeof raw !== "string") return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr as InitiativeEntry[];
    } catch (e) {
      if (e instanceof Roll20RestError && e.status === 401) return [];
      // If parsing fails, return empty rather than throwing — turnorder may
      // legitimately be empty/missing if no encounter is active.
      return [];
    }
  }

  // ─── Players ───────────────────────────────────────────────────────────

  async listPlayers(): Promise<PlayerRecord[]> {
    const all = await this.get<Record<string, PlayerRecord> | null>(
      this.campaignPath("players"),
    );
    if (!all) return [];
    return Object.entries(all).map(([id, rec]) => ({ ...rec, id }));
  }
}


// ─── world-tools types (added by apply_patch) ───
export interface PageRecord {
  id: string;
  name: string;
  width?: number;        // grid units
  height?: number;
  scale_number?: number;
  scale_units?: string;
  grid_type?: string;
  showgrid?: boolean;
  showlighting?: boolean;
  background_color?: string;
  archived?: boolean;
}

export interface TokenRecord {
  id: string;
  name?: string;
  imgsrc?: string;
  left?: number;          // pixel position
  top?: number;
  width?: number;         // pixel dims
  height?: number;
  rotation?: number;
  layer?: string;         // 'objects' | 'gmlayer' | 'map' | etc.
  represents?: string;    // characterId this token represents
  bar1_value?: string | number;
  bar1_max?: string | number;
  bar2_value?: string | number;
  bar2_max?: string | number;
  bar3_value?: string | number;
  bar3_max?: string | number;
  status_markers?: string;  // comma-separated marker names (e.g. "dead,poisoned")
  tooltip?: string;
  gmnotes?: string;
  controlledby?: string;
  page_id?: string;       // populated by us (Firebase stores tokens nested under page)
}

export interface PlayerRecord {
  id: string;
  d20userid?: string;
  displayname?: string;
  color?: string;
  online?: boolean;
  lastActive?: number;
  lastpage?: string;
  showmacrobar?: boolean;
  speakingas?: string;    // last speakingAs selection (player or character id)
  globalvolume?: number;
}

/** Roll20 stores turnorder as a JSON string at /campaign/turnorder.
 *  Parse it into structured entries. */
export interface InitiativeEntry {
  id: string;            // token id (or "-1" for custom entries)
  pr: number | string;   // initiative value
  custom?: string;       // custom name (when id="-1")
  formula?: string;      // optional auto-roll formula
  pageid?: string;
}

export { decode, decodePath };
