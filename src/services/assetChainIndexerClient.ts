import { createHash } from "node:crypto";

export type SubQuerySchemaField = { name: string };
export type SubQueryIndexerStatus = {
  provider: "subquery";
  endpoint: string;
  checkedAt: string;
  queryRoot: string;
  availableQueries: string[];
  schemaHash: string;
};

const ROOT_QUERY = `query AssetChainIndexerSchema {
  __schema {
    queryType {
      name
      fields { name }
    }
  }
}`;

function getIndexerConfig(): { endpoint: URL; token?: string } {
  const raw = process.env.ASSET_CHAIN_INDEXER_GRAPHQL_URL?.trim();
  if (!raw) throw new Error("ASSET_CHAIN_INDEXER_GRAPHQL_URL is not configured.");
  let endpoint: URL;
  try { endpoint = new URL(raw); } catch { throw new Error("ASSET_CHAIN_INDEXER_GRAPHQL_URL must be a valid URL."); }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) {
    throw new Error("Asset Chain indexer endpoint must use HTTPS (HTTP is allowed only for localhost development).");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Asset Chain indexer URL must not embed credentials or a fragment.");
  }
  return { endpoint, token: process.env.SUBQL_ACCESS_TOKEN?.trim() || undefined };
}

async function graphqlRequest<T>(query: string): Promise<T> {
  const { endpoint, token } = getIndexerConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Asset Chain indexer returned HTTP ${response.status}.`);
    const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
    if (payload.errors?.length) {
      const message = payload.errors.map((item) => item.message || "GraphQL error").join("; ").slice(0, 400);
      throw new Error(`Asset Chain indexer GraphQL error: ${message}`);
    }
    if (!payload.data) throw new Error("Asset Chain indexer returned an empty GraphQL response.");
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Introspects the configured SubQuery GraphQL endpoint without assuming
 * generated entity names. The schema is deliberately discovered at runtime:
 * the deployed Asset Chain project schema must be verified before any entity
 * query is hard-coded into market automation.
 */
export async function inspectAssetChainIndexer(): Promise<SubQueryIndexerStatus> {
  const { endpoint } = getIndexerConfig();
  const result = await graphqlRequest<{
    __schema: { queryType: { name: string; fields: SubQuerySchemaField[] } };
  }>(ROOT_QUERY);
  const queryRoot = result.__schema?.queryType;
  if (!queryRoot?.name || !Array.isArray(queryRoot.fields)) {
    throw new Error("Asset Chain indexer GraphQL schema is missing its query root.");
  }
  const availableQueries = queryRoot.fields.map((field) => field.name).sort();
  return {
    provider: "subquery",
    endpoint: endpoint.origin + endpoint.pathname,
    checkedAt: new Date().toISOString(),
    queryRoot: queryRoot.name,
    availableQueries,
    schemaHash: createHash("sha256").update(availableQueries.join("\n")).digest("hex"),
  };
}
