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
  assert.throws(() => parseGenerationTemplates(JSON.stringify([invalid])), /not approved for the .* market category/i);
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

test("template parser rejects more than ten templates in one enabled category", () => {
  const tooMany = Array.from({ length: 11 }, (_, index) => ({ ...validTemplate, id: `digital-${index}` }));
  assert.throws(() => parseGenerationTemplates(JSON.stringify(tooMany)), /maximum of 10 templates/i);
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
