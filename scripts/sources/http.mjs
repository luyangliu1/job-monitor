export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function httpError(company, sourceName, label, response, body) {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const detail = String(body || "empty response body").replace(/\s+/g, " ").trim().slice(0, 1000);
  return new Error(`[${company}] ${sourceName} ${label} failed: ${status}: ${detail}`);
}

export async function fetchJson(
  url,
  {
    company,
    sourceName,
    label,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  },
) {
  if (typeof fetchImpl !== "function") throw new Error(`${sourceName} requires a fetch implementation`);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error.cause;
    const causeDetail = cause ? [cause.code, cause.message].filter(Boolean).join(": ") : "";
    throw new Error(
      `[${company}] ${sourceName} ${label} failed: ${error.message}${causeDetail ? ` (${causeDetail})` : ""}`,
    );
  }
  const text = await response.text();
  if (!response.ok) throw httpError(company, sourceName, label, response, text);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `[${company}] ${sourceName} ${label} returned invalid JSON: ${text.replace(/\s+/g, " ").trim().slice(0, 1000)}`,
    );
  }
}
