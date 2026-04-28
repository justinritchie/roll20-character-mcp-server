/**
 * Roll20 stores Beacon character sheet data as a giant nested JSON blob in
 * a single Firebase attribute named `store`. Several inner fields are
 * themselves JSON-encoded strings (double-encoded). These helpers handle
 * "decode if string" cleanly so callers don't have to think about it.
 */

export function decode<T = unknown>(value: unknown): T {
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

/** Decode a chain of nested fields, each potentially a JSON-encoded string. */
export function decodePath(root: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = decode(root);
  for (const seg of path) {
    if (cur == null) return undefined;
    cur = decode((cur as Record<string | number, unknown>)[seg]);
  }
  return cur;
}

export interface Hitpoints {
  currentHP: number;
  tempHP: number;
  deathSaves: { successes: number; failures: number; open: boolean };
}

export interface SpellSlots {
  currentByLevel: Record<SlotLevel, number>;
  currentPactByLevel: Record<SlotLevel, number>;
  useSpellSlotOnCast: boolean;
}

export type SlotLevel =
  | "CANTRIP" | "FIRST" | "SECOND" | "THIRD" | "FOURTH"
  | "FIFTH" | "SIXTH" | "SEVENTH" | "EIGHTH" | "NINTH";

/** A single integrant entry — could be Spell, Attack, Feature, Item, Condition, etc. */
export interface Integrant {
  type: string;
  name?: string;
  _enabled?: boolean;
  _label?: string;
  _prepared?: boolean;
  alwaysPrepared?: boolean;
  arrayPosition?: number;
  parentID?: string;
  childIDs?: string;
  shortID?: string;
  source?: string;
  sourceID?: string;
  description?: string;
  level?: number | string;
  school?: string;
  castingTime?: string;
  range?: string;
  duration?: string;
  components?: {
    verbal?: boolean;
    somatic?: boolean;
    material?: boolean;
    materialDescription?: string;
  };
  ritual?: boolean;
  attack?: { type?: string; proficiencyLevel?: string };
  actionType?: string;
  valueFormula?: unknown;
  isFixed?: boolean;
  isTemp?: boolean;
  calculation?: string;
  [key: string]: unknown;
}

export interface IntegrantsBlob {
  integrants: Record<string, Integrant>;
}

/** The shape of `store.current` once fully decoded. */
export interface BeaconStore {
  about?: Record<string, unknown> | string;
  actions?: Record<string, unknown> | string;
  attacks?: { attackDisplayOrder?: string | string[] } | string;
  background?: Record<string, unknown> | string;
  bastion?: Record<string, unknown> | string;
  character?: Record<string, unknown> | string;
  classLevel?: Record<string, unknown> | string;
  currencies?: Record<string, unknown> | string;
  effects?: Record<string, unknown> | string;
  features?: {
    classFeatureDisplayOrder?: string | string[];
    featsDisplayOrder?: string | string[];
    otherDisplayOrder?: string | string[];
    speciesTraitsDisplayOrder?: string | string[];
  } | string;
  hitpoints?: Hitpoints | string;
  inspiration?: { isInspired?: boolean } | string;
  integrants?: IntegrantsBlob | string;
  inventory?: {
    equipmentDisplayOrder?: string | string[];
    otherPossessionsDisplayOrder?: string | string[];
    incrementalQuantityEditing?: unknown;
  } | string;
  notes?: Record<string, unknown> | string;
  npc?: Record<string, unknown> | string;
  rest?: Record<string, unknown> | string;
  settings?: Record<string, unknown> | string;
  shop?: Record<string, unknown> | string;
  spellSlots?: SpellSlots | string;
  spells?: {
    /** Array (one entry per spell level, 0 = cantrip … 9 = 9th) of stringified UID arrays. */
    displayOrder?: (string | string[])[] | string;
    generalSpellSettings?: Record<string, unknown> | string;
  } | string;
  weaponMasteries?: Record<string, unknown> | string;
  [key: string]: unknown;
}

/** Decode an array-of-stringified-arrays display order into a 2D UID grid. */
export function decodeDisplayOrderGrid(
  raw: unknown,
): string[][] {
  const arr = decode<unknown[]>(raw);
  if (!Array.isArray(arr)) return [];
  return arr.map((row) => {
    const decoded = decode<unknown>(row);
    return Array.isArray(decoded) ? (decoded as string[]) : [];
  });
}

/** Decode a flat stringified-array display order into a list of UIDs. */
export function decodeDisplayOrder(raw: unknown): string[] {
  const arr = decode<unknown>(raw);
  return Array.isArray(arr) ? (arr as string[]) : [];
}

const SLOT_LEVELS: SlotLevel[] = [
  "CANTRIP", "FIRST", "SECOND", "THIRD", "FOURTH",
  "FIFTH", "SIXTH", "SEVENTH", "EIGHTH", "NINTH",
];

/** Convert a level index (0..9) to the Beacon slot level constant. */
export function slotLevelFromIndex(idx: number): SlotLevel | undefined {
  return SLOT_LEVELS[idx];
}

export function slotLevelToOrdinal(level: SlotLevel): number {
  return SLOT_LEVELS.indexOf(level);
}
