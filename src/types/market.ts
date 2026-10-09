export type MarketOutcome = "YES" | "NO";

export type MarketStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "OPEN"
  | "CLOSED"
  | "RESOLVED"
  | "CANCELLED";

export type MarketCategory =
  | "Crypto"
  | "Sports"
  | "Economics"
  | "RWA"
  | "Regional";

export type ComparisonOperator =
  | "ABOVE"
  | "BELOW"
  | "EQUALS";

export interface MarketResolutionRule {
  sourceId: string;
  metric: string;
  comparison: ComparisonOperator;
  targetValue: number;
  currency?: string;
  observationTime: string;
  description: string;
}

export interface MarketRecord {
  id: string;
  question: string;
  description: string;
  category: MarketCategory;
  outcomes: readonly ["YES", "NO"];
  status: MarketStatus;
  createdAt: string;
  closesAt: string;
  resolvesAt: string;
  resolutionRule: MarketResolutionRule;
  createdBy: string;
}