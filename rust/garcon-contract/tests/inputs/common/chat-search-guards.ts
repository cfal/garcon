export function isSearchRequest(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.query === "string"
    && (request.mode == null || request.mode === "page" || request.mode === "prefix")
    && (request.sort == null || request.sort === "relevance" || request.sort === "activity" || request.sort === "created");
}

export function isSearchFailureStage(value: unknown): boolean {
  return value === "adoption" || value === "ledger" || value === "indexing";
}
