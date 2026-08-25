import { DEFAULT_HTTP_TIMEOUT_MS, fetchJson, nonEmptyString } from "./http.mjs";

const DEFAULT_BASE_URL = "https://boards-api.greenhouse.io";
const GREENHOUSE_BOARD_HOSTS = new Set(["job-boards.greenhouse.io", "boards.greenhouse.io"]);

export function extractBoardToken(boardUrl) {
  const raw = nonEmptyString(boardUrl);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid Greenhouse board URL");
  }
  if (parsed.protocol !== "https:" || !GREENHOUSE_BOARD_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Greenhouse board URL must use https://job-boards.greenhouse.io or https://boards.greenhouse.io");
  }
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  if (pathSegments.length === 0) throw new Error("Greenhouse board URL does not contain a board token");
  let boardToken;
  try {
    boardToken = decodeURIComponent(pathSegments[0]);
  } catch {
    throw new Error("Greenhouse board URL contains an invalid board token");
  }
  if (!/^[a-z0-9_-]+$/iu.test(boardToken)) {
    throw new Error("Greenhouse board URL contains an invalid board token");
  }
  return boardToken;
}

function publicJobUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export async function getJobs(companyConfig, options = {}) {
  const company = nonEmptyString(companyConfig.company);
  if (!company) throw new Error("Greenhouse company name is required");
  const sourceConfig = companyConfig.source_config;
  if (!sourceConfig || typeof sourceConfig !== "object" || Array.isArray(sourceConfig)) {
    throw new Error(`[${company}] Greenhouse source_config is required`);
  }
  const boardUrl = nonEmptyString(sourceConfig.board_url);
  const boardToken = extractBoardToken(boardUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
  const log = options.log || (() => {});
  const baseUrl = String(options.baseUrl || process.env.GREENHOUSE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const jobsUrl = `${baseUrl}/v1/boards/${encodeURIComponent(boardToken)}/jobs`;

  log(`[${company}] source=greenhouse`);
  log(`[${company}] board=${boardToken}`);
  log(`[${company}] retrieving Greenhouse jobs`);
  const data = await fetchJson(jobsUrl, {
    company,
    sourceName: "Greenhouse",
    label: "jobs request",
    fetchImpl,
    timeoutMs,
  });
  if (!Array.isArray(data.jobs)) {
    throw new Error(`[${company}] Greenhouse jobs response is malformed: jobs[] is missing`);
  }
  log(`[${company}] found ${data.jobs.length} jobs`);

  const jobs = [];
  let malformedCount = 0;
  for (const job of data.jobs) {
    const name = nonEmptyString(job?.title);
    const url = publicJobUrl(job?.absolute_url);
    if (!name || !url) {
      malformedCount += 1;
      continue;
    }
    jobs.push({ name, url });
  }
  if (malformedCount > 0) {
    log(`[${company}] skipped ${malformedCount} malformed Greenhouse job${malformedCount === 1 ? "" : "s"}`);
  }
  if (data.jobs.length > 0 && jobs.length === 0) {
    throw new Error(`[${company}] Greenhouse returned jobs, but none had both title and absolute_url`);
  }
  log(`[${company}] normalized ${jobs.length} jobs`);
  return jobs;
}
