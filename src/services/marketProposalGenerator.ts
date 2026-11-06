import { z } from "zod";
import { marketProposalSchema, type MarketProposalInput } from "./marketValidation.js";
import { claimNextGenerationCategory, saveMarketCandidate } from "./marketGenerationStore.js";

const generationTemplateSchema = z.object({
  id: z.string().trim().min(1).max(100),
  category: z.enum(["Digital Assets", "Sports", "Economics", "RWA", "Regional"]),
  question: z.string().trim().min(15).max(240),
  description: z.string().trim().min(20).max(2000),
  sport: z.enum(["football", "basketball", "tennis"]).optional(),
  dateOffsetDays: z.number().int().min(1).max(30).optional(),
  sourceId: z.string().trim().min(1).max(80),
  metric: z.string().trim().min(1).max(200),
  comparison: z.enum(["ABOVE", "AT_LEAST", "BELOW", "EQUALS"]),
  targetValue: z.number().finite(),
  currency: z.string().trim().min(1).max(12).optional(),
  query: z.record(z.string(), z.unknown()),
  closeAfterMinutes: z.number().int().min(5).max(525600),
  resolveAfterMinutes: z.number().int().min(6).max(525600),
}).strict().superRefine((template, context) => {
  const isSports = template.category === "Sports";
  if (isSports && template.sport !== "football") {
    context.addIssue({ code: "custom", path: ["sport"], message: "The configured Sportmonks and API-Football adapters currently support football only." });
  }
  if (isSports && !template.query.date && template.dateOffsetDays === undefined) {
    context.addIssue({ code: "custom", path: ["dateOffsetDays"], message: "Sports templates require query.date or dateOffsetDays." });
  }
  if (isSports && template.query.date && template.dateOffsetDays !== undefined) {
    context.addIssue({ code: "custom", path: ["dateOffsetDays"], message: "Use either a fixed query.date or dateOffsetDays, not both." });
  }
  if (!isSports && template.dateOffsetDays !== undefined) {
    context.addIssue({ code: "custom", path: ["dateOffsetDays"], message: "dateOffsetDays is only valid for Sports templates." });
  }
});

export type GenerationTemplate = z.infer<typeof generationTemplateSchema> & {
  query: NonNullable<MarketProposalInput["resolutionRule"]["query"]>;
};

function utcDateOffset(baseTime: number, offsetDays: number): string {
  const base = new Date(baseTime);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offsetDays))
    .toISOString()
    .slice(0, 10);
}

function resolveTemplate(template: z.infer<typeof generationTemplateSchema>, now: number): GenerationTemplate {
  const query = { ...template.query };
  if (template.category === "Sports" && template.dateOffsetDays !== undefined) {
    const fixtureDate = utcDateOffset(now, template.dateOffsetDays);
    query.date = fixtureDate;
    if (template.sourceId.trim().toLowerCase() === "api-football") {
      const date = new Date(`${fixtureDate}T00:00:00.000Z`);
      query.season = date.getUTCMonth() >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
    }
  }
  const fixtureDate = template.category === "Sports" ? String(query.date ?? "") : "";
  return {
    ...template,
    question: template.question.replaceAll("{{fixtureDate}}", fixtureDate),
    description: template.description.replaceAll("{{fixtureDate}}", fixtureDate),
    query: query as GenerationTemplate["query"],
  };
}

/** Parse the secret as untrusted configuration before any database writes occur. */
export function parseGenerationTemplates(raw: string): GenerationTemplate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MARKET_GENERATION_TEMPLATES_JSON must contain valid JSON.");
  }
  const result = z.array(generationTemplateSchema).max(100).safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid market generation template at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  const ids = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const now = Date.now();
  const templates = result.data.map((template) => resolveTemplate(template, now));
  for (const template of templates) {
    const count = (categoryCounts.get(template.category) ?? 0) + 1;
    categoryCounts.set(template.category, count);
    if (count > 10) throw new Error(`A maximum of 10 templates is allowed for ${template.category} per rotation.`);
    if (ids.has(template.id)) throw new Error(`Duplicate market generation template ID: ${template.id}`);
    ids.add(template.id);
    const proposal = marketProposalSchema.safeParse({
      question: template.question,
      description: template.description,
      category: template.category,
      ...(template.sport ? { sport: template.sport } : {}),
      closesAt: new Date(now + template.closeAfterMinutes * 60_000).toISOString(),
      resolvesAt: new Date(now + template.resolveAfterMinutes * 60_000).toISOString(),
      resolutionRule: {
        sourceId: template.sourceId,
        metric: template.metric,
        comparison: template.comparison,
        targetValue: template.targetValue,
        ...(template.currency ? { currency: template.currency } : {}),
        observationTime: new Date(now).toISOString(),
        description: `Resolve using the configured ${template.sourceId} source and the ${template.metric} metric at the specified observation time.`,
        query: template.query,
      },
    });
    if (!proposal.success) {
      const issue = proposal.error.issues[0];
      throw new Error(`Invalid template "${template.id}" at ${issue.path.join(".")}: ${issue.message}`);
    }
  }
  const requiredCategories = ["Digital Assets", "Economics", "Regional", "RWA", "Sports"];
  const missingCategories = requiredCategories.filter((category) => !categoryCounts.has(category));
  if (missingCategories.length) {
    throw new Error(`MARKET_GENERATION_TEMPLATES_JSON is missing category coverage: ${missingCategories.join(", ")}.`);
  }
  return templates;
}

function readTemplates(): GenerationTemplate[] {
  const raw = process.env.MARKET_GENERATION_TEMPLATES_JSON?.trim();
  if (!raw) throw new Error("MARKET_GENERATION_TEMPLATES_JSON is required; no candidates were generated.");
  return parseGenerationTemplates(raw);
}

export async function generateNextMarketCandidate(): Promise<{
  category: MarketProposalInput["category"];
  considered: number;
  inserted: number;
  duplicates: number;
  invalid: number;
}> {
  const templates = readTemplates();
  const category = await claimNextGenerationCategory();
  const selected = templates.filter((template) => template.category === category);
  if (selected.length === 0) {
    throw new Error(`No approved generation templates are configured for ${category}.`);
  }
  let inserted = 0, duplicates = 0, invalid = 0;
  const now = Date.now();

  for (const template of selected) {
    const proposal = marketProposalSchema.safeParse({
      question: template.question,
      description: template.description,
      category: template.category,
      ...(template.sport ? { sport: template.sport } : {}),
      closesAt: new Date(now + template.closeAfterMinutes * 60_000).toISOString(),
      resolvesAt: new Date(now + template.resolveAfterMinutes * 60_000).toISOString(),
      resolutionRule: {
        sourceId: template.sourceId,
        metric: template.metric,
        comparison: template.comparison,
        targetValue: template.targetValue,
        ...(template.currency ? { currency: template.currency } : {}),
        observationTime: new Date(now).toISOString(),
        description: `Resolve using the configured ${template.sourceId} source and the ${template.metric} metric at the specified observation time.`,
        query: template.query,
      },
    });
    if (!proposal.success) {
      invalid++;
      continue;
    }
    const saved = await saveMarketCandidate({ templateId: template.id, proposal: proposal.data, closeAfterMinutes: template.closeAfterMinutes, resolveAfterMinutes: template.resolveAfterMinutes });
    if (saved.inserted) inserted++; else duplicates++;
  }

  return { category, considered: selected.length, inserted, duplicates, invalid };
}
