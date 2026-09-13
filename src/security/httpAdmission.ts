export function isJsonRpcBatch(body: unknown): body is unknown[] {
  return Array.isArray(body);
}
