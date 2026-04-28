/**
 * Configuration loader.
 *
 * Resolution order (later wins):
 *   1. ~/.mcp-credentials/roll20.json    (written by mcp-auth-bridge)
 *   2. Environment variables             (CI / direct invocation)
 *
 * The credential file uses the bearer_json shape produced by the bridge:
 *   {
 *     "type": "roll20",
 *     "access_token": "<jwt>",
 *     "database_url": "https://...",
 *     "campaign_path": "campaign-NNN-...",
 *     "player_id": "-OXXXXX",
 *     "default_character_id": "-OXXXXX",
 *     "captured_at": "2026-..."
 *   }
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedConfig {
  databaseUrl: string;
  idToken: string;
  campaignPath: string;
  defaultCharacterId?: string;
  playerId?: string;
  capturedAt?: string;
  source: { credentialFile: boolean; env: boolean };
}

interface CredentialFile {
  type?: string;
  access_token?: string;
  database_url?: string;
  campaign_path?: string;
  player_id?: string;
  default_character_id?: string;
  captured_at?: string;
}

function readCredentialFile(): CredentialFile | null {
  const path =
    process.env.ROLL20_CREDENTIAL_FILE ||
    join(homedir(), ".mcp-credentials", "roll20.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as CredentialFile;
  } catch (e) {
    console.error(`[roll20-mcp] failed to read credential file ${path}:`, e);
    return null;
  }
}

export function resolveConfig(): ResolvedConfig {
  const file = readCredentialFile();
  const fileSource = !!file;

  // Pull from file first, then let env override field-by-field
  const databaseUrl = process.env.ROLL20_FIREBASE_DB_URL ?? file?.database_url;
  const idToken = process.env.ROLL20_FIREBASE_ID_TOKEN ?? file?.access_token;
  const campaignPath = process.env.ROLL20_CAMPAIGN_PATH ?? file?.campaign_path;
  const defaultCharacterId =
    process.env.ROLL20_DEFAULT_CHARACTER_ID ?? file?.default_character_id;
  const playerId = process.env.ROLL20_PLAYER_ID ?? file?.player_id;
  const capturedAt = file?.captured_at;
  const envSource = !!(
    process.env.ROLL20_FIREBASE_DB_URL ||
    process.env.ROLL20_FIREBASE_ID_TOKEN ||
    process.env.ROLL20_CAMPAIGN_PATH
  );

  const missing: string[] = [];
  if (!databaseUrl) missing.push("database_url / ROLL20_FIREBASE_DB_URL");
  if (!idToken) missing.push("access_token / ROLL20_FIREBASE_ID_TOKEN");
  if (!campaignPath) missing.push("campaign_path / ROLL20_CAMPAIGN_PATH");
  if (missing.length) {
    console.error(
      `[roll20-mcp] missing required config:\n  ${missing.join("\n  ")}\n` +
        `Provide either via ~/.mcp-credentials/roll20.json (written by mcp-auth-bridge) or env vars.`,
    );
    process.exit(1);
  }

  return {
    databaseUrl: databaseUrl!,
    idToken: idToken!,
    campaignPath: campaignPath!,
    defaultCharacterId,
    playerId,
    capturedAt,
    source: { credentialFile: fileSource, env: envSource },
  };
}
