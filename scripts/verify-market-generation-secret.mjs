const secretName = "MARKET_GENERATION_TEMPLATES_JSON";
const raw = process.env[secretName];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!raw || !raw.trim()) {
  fail(`${secretName} is missing or empty.`);
}

let templates;
try {
  templates = JSON.parse(raw);
} catch {
  fail(`${secretName} is not valid JSON. The secret value was not printed.`);
}

if (!Array.isArray(templates) || templates.length === 0) {
  fail("The secret must contain a non-empty JSON array.");
}

const required = new Map([
  ["bitcoin", "BTC"],
  ["ethereum", "ETH"],
  ["binancecoin", "BNB"],
  ["solana", "SOL"],
  ["ripple", "XRP"],
]);
const excluded = new Set(["dogecoin", "cardano"]);
const coinGeckoTemplates = templates.filter(
  (item) => item && typeof item === "object" &&
    typeof item.sourceId === "string" &&
    item.sourceId.trim().toLowerCase() === "coingecko"
);

const seen = new Set();
for (const item of coinGeckoTemplates) {
  const coinId = typeof item.query?.coinId === "string"
    ? item.query.coinId.trim().toLowerCase()
    : "";
  if (coinId && seen.has(coinId)) {
    fail(`Duplicate CoinGecko template for asset ID: ${coinId}.`);
  }
  if (coinId) seen.add(coinId);
  if (excluded.has(coinId)) {
    fail(`Excluded asset is present in CoinGecko templates: ${coinId}.`);
  }
}

for (const [coinId, ticker] of required) {
  const matches = coinGeckoTemplates.filter(
    (item) => typeof item.query?.coinId === "string" &&
      item.query.coinId.trim().toLowerCase() === coinId
  );
  if (matches.length !== 1) {
    fail(`${ticker} must have exactly one CoinGecko template; found ${matches.length}.`);
  }

  const item = matches[0];
  const valid =
    item.category === "Digital Assets" &&
    item.metric === "market_data.current_price.usd" &&
    item.comparison === "ABOVE" &&
    typeof item.targetValue === "number" &&
    Number.isFinite(item.targetValue) &&
    item.targetValue > 0 &&
    typeof item.currency === "string" &&
    item.currency.toUpperCase() === "USD" &&
    typeof item.query?.vsCurrency === "string" &&
    item.query.vsCurrency.toLowerCase() === "usd" &&
    Number.isInteger(item.closeAfterMinutes) &&
    item.closeAfterMinutes >= 5 &&
    Number.isInteger(item.resolveAfterMinutes) &&
    item.resolveAfterMinutes > item.closeAfterMinutes &&
    typeof item.id === "string" &&
    item.id.trim().length > 0;

  if (!valid) {
    fail(`${ticker} (${coinId}) is present but has invalid or incomplete market settings.`);
  }
  console.log(`PASS ${ticker}: CoinGecko ID and market settings are valid.`);
}

console.log("PASS DOGE and ADA are absent from CoinGecko templates.");
console.log("SUCCESS: the secret contains valid BTC, ETH, BNB, SOL and XRP templates.");
console.log("The secret contents were not printed. No database or market-generation code was run.");
