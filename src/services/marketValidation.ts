import { z } from "zod";

const resolutionRuleSchema = z.object({
  sourceId: z.string().trim().min(1, "A data source is required"),
  metric: z.string().trim().min(1, "A metric is required"),
  comparison: z.enum(["ABOVE", "AT_LEAST", "BELOW", "EQUALS"]),
  targetValue: z.number().finite(),
  currency: z.string().trim().optional(),
  observationTime: z.string().datetime({
    offset: true,
    message: "Use a valid ISO 8601 observation time with timezone",
  }),
  description: z.string().trim().min(10, "Explain the resolution rule"),
  query: z.object({
    coinId: z.string().trim().min(1).max(100).optional(),
    vsCurrency: z.string().trim().min(2).max(12).optional(),
    page: z.number().int().min(1).max(1000).optional(),
    perPage: z.number().int().min(1).max(250).optional(),
    search: z.string().trim().min(1).max(250).optional(),
    timespan: z.string().regex(/^(15min|[1-9]\d*(min|h|hours|d|days|w|weeks|m|months))$/).max(12).optional(),
    maxRecords: z.number().int().min(1).max(250).optional(),
    chain: z.string().trim().min(1).max(40).optional(),
    tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    protocol: z.string().trim().min(1).max(100).optional(),
    date: z.string().date().optional(),
    league: z.number().int().positive().optional(),
    season: z.number().int().min(1900).max(2200).optional(),
    seriesId: z.string().trim().min(1).max(80).optional(),
    start: z.string().date().optional(),
    end: z.string().date().optional(),
    country: z.string().trim().min(2).max(3).optional(),
    indicator: z.string().trim().min(1).max(80).optional(),
    dateRange: z.string().regex(/^\d{4}:\d{4}$/).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
  }).optional(),
});

export const marketProposalSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(15, "The question must contain at least 15 characters")
      .max(240, "The question cannot exceed 240 characters"),

    description: z
      .string()
      .trim()
      .min(20, "Provide at least 20 characters of description")
      .max(2000, "The description cannot exceed 2000 characters"),

    category: z.enum([
      "Digital Assets",
      "Sports",
      "Economics",
      "RWA",
      "Regional",
    ]),
    sport: z.enum(["football", "basketball", "tennis"]).optional(),

    closesAt: z.string().datetime({
      offset: true,
      message: "Use a valid ISO 8601 closing date with timezone",
    }),

    resolvesAt: z.string().datetime({
      offset: true,
      message: "Use a valid ISO 8601 resolution date with timezone",
    }),

    resolutionRule: resolutionRuleSchema,
  })
  .superRefine((market, context) => {
    if (market.category === "Sports" && !market.sport) {
      context.addIssue({ code: "custom", path: ["sport"], message: "Choose football, basketball, or tennis for a sports market." });
    }
    if (market.category !== "Sports" && market.sport) {
      context.addIssue({ code: "custom", path: ["sport"], message: "Sport can only be set for Sports markets." });
    }
    const providerAllowlist: Record<string, string[]> = {
      "Digital Assets": ["coingecko", "dexscreener"],
      Sports: ["sportmonks", "api-football"],
      Economics: ["fred", "world-bank"],
      RWA: ["defillama", "dexscreener"],
      Regional: ["gdelt", "open-meteo"],
    };
    const sourceId = market.resolutionRule.sourceId.trim().toLowerCase();
    if (!providerAllowlist[market.category]?.includes(sourceId)) {
      context.addIssue({ code: "custom", path: ["resolutionRule", "sourceId"], message: "Choose a provider approved for this market category." });
    }
    const query = market.resolutionRule.query;
    const requiredQueryFields: Record<string, string[]> = {
      coingecko: ["coinId"], dexscreener: [], defillama: ["protocol"], sportmonks: ["date"],
      "api-football": ["date"], fred: ["seriesId"], "world-bank": ["country", "indicator"],
      gdelt: ["search", "timespan"], "open-meteo": ["latitude", "longitude", "startDate", "endDate"],
    };
    const missing = (requiredQueryFields[sourceId] ?? []).filter((field) =>
      !query || query[field as keyof typeof query] === undefined
    );
    if (sourceId === "dexscreener" && !query?.search?.trim() && !(query?.chain?.trim() && query?.tokenAddress)) {
      missing.push("search or both chain and tokenAddress");
    }
    if (missing.length) {
      context.addIssue({ code: "custom", path: ["resolutionRule", "query"], message: `Provider query requires: ${missing.join(", ")}.` });
    }
    if (query?.start && query?.end && query.start > query.end) {
      context.addIssue({ code: "custom", path: ["resolutionRule", "query"], message: "Query start date must not be after end date." });
    }
    if (query?.startDate && query?.endDate && query.startDate > query.endDate) {
      context.addIssue({ code: "custom", path: ["resolutionRule", "query"], message: "Query start date must not be after end date." });
    }
    const now = Date.now();
    const closingTime = Date.parse(market.closesAt);
    const resolutionTime = Date.parse(market.resolvesAt);

    if (closingTime <= now) {
      context.addIssue({
        code: "custom",
        path: ["closesAt"],
        message: "The closing date must be in the future",
      });
    }

    if (resolutionTime <= closingTime) {
      context.addIssue({
        code: "custom",
        path: ["resolvesAt"],
        message: "The resolution time must be after the closing time",
      });
    }
  });

export type MarketProposalInput = z.infer<
  typeof marketProposalSchema
>;