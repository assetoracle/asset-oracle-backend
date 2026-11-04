import { strict as assert } from "node:assert";
import test from "node:test";
import { marketProposalSchema } from "./marketValidation.js";
import { parseGenerationTemplates } from "./marketProposalGenerator.js";

const validTemplate = {
  id: "btc-usd-threshold",
  category: "Crypto",
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
    category: "Crypto",
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

test("template parser accepts a structurally valid approved template", () => {
  const parsed = parseGenerationTemplates(JSON.stringify([validTemplate]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, validTemplate.id);
});
