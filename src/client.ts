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
}

export { decode, decodePath };
