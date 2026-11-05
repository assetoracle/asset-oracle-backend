export function resolveEvidenceConsensus(
  accepted: number,
  rejected: number,
): "UNREVIEWED" | "ACCEPTED" | "REJECTED" {
  if (accepted >= 2) return "ACCEPTED";
  if (rejected >= 2) return "REJECTED";
  return "UNREVIEWED";
}
