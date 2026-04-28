import { FirebaseRestClient } from "./build/client.js";
import { listCharacters } from "./build/tools/character.js";
import { searchHandouts, searchChat } from "./build/tools/campaign.js";

const client = new FirebaseRestClient({
  databaseUrl: process.env.ROLL20_FIREBASE_DB_URL,
  idToken: process.env.ROLL20_FIREBASE_ID_TOKEN,
  campaignPath: process.env.ROLL20_CAMPAIGN_PATH,
});
const ctx = {
  defaultCharacterId: process.env.ROLL20_DEFAULT_CHARACTER_ID,
  playerId: process.env.ROLL20_PLAYER_ID,
};

const time = async (label, fn) => {
  const t = Date.now();
  const r = await fn();
  console.log(`${label}: ${Date.now() - t}ms`);
  return r;
};

const lc = await time("listCharacters (170)", () => listCharacters(client, {}, ctx));
console.log(`  -> ${lc.structuredContent.characters.length} returned`);

const handoutQuery = process.env.ROLL20_SMOKE_HANDOUT_QUERY ?? "map";
const sh = await time(`searchHandouts ("${handoutQuery}")`, () =>
  searchHandouts(client, { query: handoutQuery, limit: 20 }),
);
console.log(`  -> ${sh.structuredContent.handouts.length} matched`);

const sh2 = await time('searchHandouts ("citadel", includeNotes=true)', () =>
  searchHandouts(client, { query: "citadel", limit: 5, includeNotes: true }),
);
console.log(`  -> ${sh2.structuredContent.handouts.length} matched`);

const sc = await time("searchChat (recent 100, type=rollresult)", () =>
  searchChat(client, { recent: 100, type: "rollresult" }),
);
console.log(`  -> ${sc.structuredContent.messages.length} returned`);
console.log(sc.text.split("\n").slice(0, 3).join("\n"));

const sc2 = await time("searchChat (recent 200)", () => searchChat(client, { recent: 200 }));
console.log(`  -> ${sc2.structuredContent.messages.length} returned`);
