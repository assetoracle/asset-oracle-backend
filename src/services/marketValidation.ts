import { z } from "zod";

const resolutionRuleSchema = z.object({
  sourceId: z.string().trim().min(1, "A data source is required"),
  metric: z.string().trim().min(1, "A metric is required"),
  comparison: z.enum(["ABOVE", "BELOW", "EQUALS"]),
  targetValue: z.number().finite(),
  currency: z.string().trim().optional(),
  observationTime: z.string().datetime({
    offset: true,
    message: "Use a valid ISO 8601 observation time with timezone",
  }),
  description: z.string().trim().min(10, "Explain the resolution rule"),
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
      "Crypto",
      "Sports",
      "Economics",
      "RWA",
      "Regional",
    ]),

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