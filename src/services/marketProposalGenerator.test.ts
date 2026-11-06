import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { marketProposalSchema } from "./marketValidation.js";

let parseGenerationTemplates: typeof import("./marketProposalGenerator.js").parseGenerationTemplates;
let generateNextMarketCandidate: typeof import("./marketProposalGenerator.js").generateNextMarketCandidate;
const originalDatabaseUrl = process.env.DATABASE_URL;

before(async () => {
  // The generator imports the database module, but these parser tests never connect to it.
  process.env.DATABASE_URL ||= "postgresql://unit-test:unit-test@127.0.0.1:5432/unit_test";
  ({ parseGenerationTemplates, generateNextMarketCandidate } = await import("./marketProposalGenerator.js"));
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

const validTemplate = {
  id: "btc-usd-threshold",
  category: "Digital Assets",
  question: "Will Bitcoin trade above 100000 USD?",
  description: "This candidate resolves using the configured CoinGecko market data at the observation time.",
  sourceId: "coingecko",
  metric: "market_data.current_price.usd",
  comparison: "ABOVE",
  targetValue: 100000,
  currency: "USD",
  query: { coinId: "bitcoin", vsCurrency: "usd" },
  closeAfterMinutes: 60,
  resolveAfterMinutes: 120,
};

test("generated candidate proposal requires future close and later resolution", () => {
  const now = Date.now();
  const proposal = {
    question: validTemplate.question,
    description: validTemplate.description,
    category: "Digital Assets",
    closesAt: new Date(now + 60 * 60_000).toISOString(),
    resolvesAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    resolutionRule: {
      sourceId: "coingecko",
      metric: validTemplate.metric,
      comparison: "ABOVE",
      targetValue: 100000,
      currency: "USD",
      observationTime: new Date(now).toISOString(),
      description: "Resolve using the CoinGecko current USD price at the specified observation time.",
      query: validTemplate.query,
    },
  };
  assert.equal(marketProposalSchema.safeParse(proposal).success, true);
});

test("template parser rejects a provider outside its category", () => {
  const invalid = { ...validTemplate, sourceId: "fred", query: { seriesId: "CPIAUCSL" } };
  assert.throws(() => parseGenerationTemplates(JSON.stringify([invalid])), /provider approved for this market category/i);
});

test("template parser rejects missing provider query parameters", () => {
  const invalid = { ...validTemplate, query: {} };
  assert.throws(() => parseGenerationTemplates(JSON.stringify([invalid])), /requires: coinId/i);
});

test("template parser rejects malformed fields and unknown properties", () => {
  assert.throws(() => parseGenerationTemplates(JSON.stringify([{ ...validTemplate, targetValue: "100000" }])), /targetValue/i);
  assert.throws(() => parseGenerationTemplates(JSON.stringify([{ ...validTemplate, unexpected: true }])), /Unrecognized key/i);
});

test("template parser rejects duplicate IDs and unsafe time offsets", () => {
  assert.throws(() => parseGenerationTemplates(JSON.stringify([validTemplate, validTemplate])), /Duplicate market generation template ID/);
  assert.throws(() => parseGenerationTemplates(JSON.stringify([{ ...validTemplate, resolveAfterMinutes: 30 }])), /resolution time must be after the closing time/i);
});

function completeTemplateSet() {
  return [
    validTemplate,
    { ...validTemplate, id: "economics-cpi", category: "Economics", question: "Will US CPI exceed the selected threshold?", description: "This candidate resolves using the configured FRED series at the observation time.", sourceId: "fred", metric: "observations.0.value", query: { seriesId: "CPIAUCSL" } },
    { ...validTemplate, id: "regional-event", category: "Regional", question: "Will GDELT index at least one Nigeria flood article in the 24-hour evidence window?", description: "Resolve using the number of GDELT articles matching the Nigeria flood search in the rolling 24-hour window before evidence collection.", sourceId: "gdelt", metric: "articles.length", query: { search: '"Nigeria" flood', timespan: "24h", maxRecords: 100 } },
    { ...validTemplate, id: "rwa-tvl", category: "RWA", question: "Will the selected RWA protocol TVL exceed the threshold?", description: "This candidate resolves using the configured DeFiLlama protocol TVL at the observation time.", sourceId: "defillama", metric: "tvl", query: { protocol: "example-protocol" } },
    { ...validTemplate, id: "sports-match", category: "Sports", sport: "football", question: "Will the English Premier League have a scheduled fixture on {{fixtureDate}}?", description: "Resolve using the Sportmonks fixture list for {{fixtureDate}}.", sourceId: "sportmonks", metric: "data.length", query: {}, dateOffsetDays: 7 },
  ];
}

test("template parser accepts a structurally valid template set covering all five categories", () => {
  const parsed = parseGenerationTemplates(JSON.stringify(completeTemplateSet()));
  assert.equal(parsed.length, 5);
  assert.deepEqual(new Set(parsed.map((item) => item.category)), new Set(["Digital Assets", "Economics", "Regional", "RWA", "Sports"]));
});

test("template parser rejects missing category coverage", () => {
  assert.throws(() => parseGenerationTemplates(JSON.stringify([validTemplate])), /missing category coverage/i);
});

test("template parser rejects more than ten templates in one category", () => {
  const tooMany = Array.from({ length: 11 }, (_, index) => ({ ...validTemplate, id: `digital-${index}` }));
  assert.throws(() => parseGenerationTemplates(JSON.stringify([...tooMany, ...completeTemplateSet().slice(1)])), /maximum of 10 templates/i);
});

test("template parser accepts DexScreener token-pair query without search", () => {
  const templates = completeTemplateSet() as Array<Record<string, unknown>>;
  templates[0] = { ...validTemplate, sourceId: "dexscreener", metric: "priceUsd", query: { chain: "ethereum", tokenAddress: "0x0000000000000000000000000000000000000001" } };
  const parsed = parseGenerationTemplates(JSON.stringify(templates));
  assert.equal(parsed[0].sourceId, "dexscreener");
});


test("GDELT templates require a bounded search window", () => {
  const templates = completeTemplateSet() as Array<Record<string, unknown>>;
  templates[2] = { ...templates[2], query: { search: '"Nigeria" flood' } };
  assert.throws(() => parseGenerationTemplates(JSON.stringify(templates)), /timespan/i);
});

test("sports dateOffsetDays resolves a fresh fixture date and interpolates market wording", () => {
  const parsed = parseGenerationTemplates(JSON.stringify(completeTemplateSet()));
  const sports = parsed.find((item) => item.category === "Sports");
  assert.ok(sports);
  const daysAhead = (Date.parse(`${sports.query.date}T00:00:00.000Z`) - Date.now()) / 86_400_000;
  assert.ok(daysAhead >= 6 && daysAhead <= 8, `expected fixture date about 7 days ahead, got ${daysAhead} days`);
  assert.equal(sports.question.includes("{{fixtureDate}}"), false);
  assert.equal(sports.question.includes(expected), true);
});

test("dynamic API-Football fixture templates derive the correct football season", () => {
  const templates = completeTemplateSet() as Array<Record<string, unknown>>;
  templates[4] = {
    ...templates[4],
    sourceId: "api-football",
    metric: "response.length",
    query: { league: 39 },
    dateOffsetDays: 7,
  };
  const parsed = parseGenerationTemplates(JSON.stringify(templates));
  const sports = parsed.find((item) => item.category === "Sports");
  assert.ok(sports);
  const fixtureDate = new Date(`${sports.query.date}T00:00:00.000Z`);
  const expectedSeason = fixtureDate.getUTCMonth() >= 7
    ? fixtureDate.getUTCFullYear()
    : fixtureDate.getUTCFullYear() - 1;
  assert.equal(sports.query.season, expectedSeason);
});

test("sports templates reject missing or conflicting fixture date configuration", () => {
  const templates = completeTemplateSet() as Array<Record<string, unknown>>;
  templates[4] = { ...templates[4], query: {} };
  assert.throws(() => parseGenerationTemplates(JSON.stringify(templates)), /dateOffsetDays/i);
  templates[4] = { ...templates[4], query: { date: "2027-01-01" }, dateOffsetDays: 7 };
  assert.throws(() => parseGenerationTemplates(JSON.stringify(templates)), /either a fixed query.date or dateOffsetDays/i);
});

test("generator fails closed before database rotation when template configuration is missing", async () => {
  const originalTemplates = process.env.MARKET_GENERATION_TEMPLATES_JSON;
  delete process.env.MARKET_GENERATION_TEMPLATES_JSON;
  try {
    await assert.rejects(generateNextMarketCandidate(), /MARKET_GENERATION_TEMPLATES_JSON is required/i);
  } finally {
    if (originalTemplates === undefined) delete process.env.MARKET_GENERATION_TEMPLATES_JSON;
    else process.env.MARKET_GENERATION_TEMPLATES_JSON = originalTemplates;
  }
});
