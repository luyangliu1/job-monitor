import { DEFAULT_HTTP_TIMEOUT_MS, fetchJson, nonEmptyString } from "./http.mjs";

const DEFAULT_BASE_URL = "https://api.smartrecruiters.com";
const PAGE_LIMIT = 100;
const DEFAULT_DETAIL_CONCURRENCY = 8;

function validateConfig(companyConfig) {
  const company = nonEmptyString(companyConfig.company);
  const sourceConfig = companyConfig.source_config;
  if (!company) throw new Error("SmartRecruiters company name is required");
  if (!sourceConfig || typeof sourceConfig !== "object" || Array.isArray(sourceConfig)) {
    throw new Error(`[${company}] SmartRecruiters source_config is required`);
  }
  const companyIdentifier = nonEmptyString(sourceConfig.company_identifier);
  const country = nonEmptyString(sourceConfig.country);
  if (!companyIdentifier) {
    throw new Error(`[${company}] SmartRecruiters company_identifier is required`);
  }
  if (!country) throw new Error(`[${company}] SmartRecruiters country is required`);
  return { company, companyIdentifier, country: country.toLowerCase() };
}

function postingIdentifier(posting) {
  return nonEmptyString(posting?.id) || nonEmptyString(posting?.uuid);
}

function validatePublicPostingUrl(value, company, postingId) {
  const raw = nonEmptyString(value);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[${company}] SmartRecruiters posting ${postingId} has no valid postingUrl`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "jobs.smartrecruiters.com") {
    throw new Error(`[${company}] SmartRecruiters posting ${postingId} has no public jobs.smartrecruiters.com postingUrl`);
  }
  return parsed.toString();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function getJobs(companyConfig, options = {}) {
  const { company, companyIdentifier, country } = validateConfig(companyConfig);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("SmartRecruiters requires a fetch implementation");
  const log = options.log || (() => {});
  const timeoutMs = options.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
  const detailConcurrency = options.detailConcurrency || DEFAULT_DETAIL_CONCURRENCY;
  const baseUrl = String(
    options.baseUrl || process.env.SMARTRECRUITERS_BASE_URL || DEFAULT_BASE_URL,
  ).replace(/\/+$/, "");
  const companyPath = `/v1/companies/${encodeURIComponent(companyIdentifier)}/postings`;

  log(`[${company}] source=smartrecruiters`);
  log(`[${company}] retrieving ${country.toUpperCase()} public postings`);

  const postings = [];
  const postingIds = new Set();
  let offset = 0;
  let totalFound = null;
  const seenOffsets = new Set();

  while (totalFound === null || postings.length < totalFound) {
    if (seenOffsets.has(offset)) {
      throw new Error(`[${company}] SmartRecruiters pagination repeated offset ${offset}`);
    }
    seenOffsets.add(offset);
    const url = new URL(`${baseUrl}${companyPath}`);
    url.searchParams.set("country", country);
    url.searchParams.set("destination", "PUBLIC");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));
    const page = await fetchJson(url, {
      company,
      sourceName: "SmartRecruiters",
      label: `posting-list request at offset ${offset}`,
      fetchImpl,
      timeoutMs,
    });
    if (!Array.isArray(page.content) || !Number.isInteger(page.totalFound) || page.totalFound < 0) {
      throw new Error(`[${company}] SmartRecruiters posting-list response at offset ${offset} is malformed`);
    }
    if (totalFound === null) totalFound = page.totalFound;
    else if (page.totalFound !== totalFound) {
      throw new Error(
        `[${company}] SmartRecruiters totalFound changed during pagination (${totalFound} to ${page.totalFound})`,
      );
    }
    if (page.content.length === 0 && postings.length < totalFound) {
      throw new Error(
        `[${company}] SmartRecruiters returned an empty page at offset ${offset} before ${totalFound} postings were retrieved`,
      );
    }
    for (const posting of page.content) {
      const id = postingIdentifier(posting);
      const name = nonEmptyString(posting?.name);
      if (!id || !name) {
        throw new Error(`[${company}] SmartRecruiters posting-list item at offset ${offset} is missing id or name`);
      }
      if (postingIds.has(id)) {
        throw new Error(`[${company}] SmartRecruiters pagination returned duplicate posting ${id}`);
      }
      postingIds.add(id);
      postings.push({ id, name });
    }
    if (postings.length >= totalFound) break;
    offset += PAGE_LIMIT;
  }

  if (postings.length !== totalFound) {
    throw new Error(
      `[${company}] SmartRecruiters pagination retrieved ${postings.length} postings but totalFound was ${totalFound}`,
    );
  }
  log(`[${company}] found ${postings.length} postings`);

  const jobs = await mapWithConcurrency(postings, detailConcurrency, async (posting) => {
    const detailUrl = `${baseUrl}${companyPath}/${encodeURIComponent(posting.id)}`;
    const detail = await fetchJson(detailUrl, {
      company,
      sourceName: "SmartRecruiters",
      label: `posting-detail request for ${posting.id}`,
      fetchImpl,
      timeoutMs,
    });
    return {
      name: posting.name,
      url: validatePublicPostingUrl(detail.postingUrl, company, posting.id),
    };
  });
  log(`[${company}] normalized ${jobs.length} jobs`);
  return jobs;
}
