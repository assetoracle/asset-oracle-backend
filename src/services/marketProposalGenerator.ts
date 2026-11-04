import { marketProposalSchema, type MarketProposalInput } from "./marketValidation.js";
import { claimNextGenerationCategory, saveMarketCandidate } from "./marketGenerationStore.js";

type GenerationTemplate = {
  id: string;
  category: MarketProposalInput["category"];
  question: string;
  description: string;
  sport?: "football" | "basketball" | "tennis";
  sourceId: string;
  metric: string;
  comparison: "ABOVE" | "AT_LEAST" | "BELOW" | "EQUALS";
  targetValue: number;
  currency?: string;
  query: NonNullable<MarketProposalInput["resolutionRule"]["query"]>;
  closeAfterMinutes: number;
  resolveAfterMinutes: number;
};

function readTemplates(): GenerationTemplate[] {
  const raw = process.env.MARKET_GENERATION_TEMPLATES_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("MARKET_GENERATION_TEMPLATES_JSON must contain valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("Market generation templates must be an array of at most 100 items.");
  return parsed as GenerationTemplate[];
}

export async function generateNextMarketCandidate(): Promise<{
  category: MarketProposalInput["category"];
  considered: number;
  inserted: number;
  duplicates: number;
  invalid: number;
}> {
  const category = await claimNextGenerationCategory();
  const templates = readTemplates().filter((template) => template.category === category);
  let inserted = 0, duplicates = 0, invalid = 0;
  const now = Date.now();

  for (const template of templates.slice(0, 10)) {
    const closeMinutes = Number(template.closeAfterMinutes);
    const resolveMinutes = Number(template.resolveAfterMinutes);
    if (!template.id || !Number.isInteger(closeMinutes) || closeMinutes < 5 ||
        !Number.isInteger(resolveMinutes) || resolveMinutes <= closeMinutes ||
        resolveMinutes > 525600) {
      invalid++;
      continue;
    }
    const observationTime = new Date(now).toISOString();
    const proposal = marketProposalSchema.safeParse({
      question: template.question,
      description: template.description,
      category: template.category,
      ...(template.sport ? { sport: template.sport } : {}),
      closesAt: new Date(now + closeMinutes * 60_000).toISOString(),
      resolvesAt: new Date(now + resolveMinutes * 60_000).toISOString(),
      resolutionRule: {
        sourceId: template.sourceId,
        metric: template.metric,
        comparison: template.comparison,
        targetValue: template.targetValue,
        ...(template.currency ? { currency: template.currency } : {}),
        observationTime,
        description: `Resolve using the configured ${template.sourceId} source and the ${template.metric} metric at the specified observation time.`,
        query: template.query,
      },
    });
    if (!proposal.success) {
      invalid++;
      continue;
    }
    const saved = await saveMarketCandidate({ templateId: template.id, proposal: proposal.data });
    if (saved.inserted) inserted++; else duplicates++;
  }

  return { category, considered: templates.length, inserted, duplicates, invalid };
}
