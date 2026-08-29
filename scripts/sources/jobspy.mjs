import { DEFAULT_HTTP_TIMEOUT_MS, nonEmptyString } from "./http.mjs";

function validateJob(value, company, index) {
  const name = nonEmptyString(value?.name);
  const url = nonEmptyString(value?.url);
  if (!name || !url) throw new Error(`[${company}] JobSpy result ${index} is missing name or url`);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new Error(`[${company}] JobSpy result ${index} has an invalid job URL`);
  }
  return {
    name,
    url,
    company: nonEmptyString(value?.company),
    location: nonEmptyString(value?.location),
    description: nonEmptyString(value?.description),
    date: nonEmptyString(value?.date),
    site: nonEmptyString(value?.site).toLowerCase(),
  };
}

export async function getJobs(companyConfig, options = {}) {
  const company = nonEmptyString(companyConfig.company);
  const sourceConfig = companyConfig.source_config;
  if (!company) throw new Error("JobSpy logical source name is required");
  if (!sourceConfig || typeof sourceConfig !== "object" || Array.isArray(sourceConfig)) {
    throw new Error(`[${company}] JobSpy source_config is required`);
  }
  const region = nonEmptyString(companyConfig.region).toUpperCase();
  const keywords = Array.isArray(sourceConfig.keywords) ? sourceConfig.keywords.map(nonEmptyString).filter(Boolean) : [];
  const sites = Array.isArray(sourceConfig.sites) ? sourceConfig.sites.map((value) => nonEmptyString(value).toLowerCase()) : [];
  const countries = region === "US" ? ["USA"] : sourceConfig.countries;
  if (keywords.length === 0 || sites.length === 0 || !Array.isArray(countries) || countries.length === 0) {
    throw new Error(`[${company}] JobSpy keywords, sites, and countries must be non-empty arrays`);
  }
  if (sites.some((site) => !["indeed", "linkedin"].includes(site))) {
    throw new Error(`[${company}] JobSpy sites may contain only indeed and linkedin`);
  }
  const searches = [];
  for (const country of countries) {
    const countryName = nonEmptyString(country);
    if (!countryName) throw new Error(`[${company}] JobSpy contains an empty country`);
    for (const keyword of keywords) {
      for (const site of sites) {
        searches.push({
          site,
          search_term: site === "indeed" ? `"${keyword}"` : keyword,
          location: region === "US" ? "United States" : countryName,
          country_indeed: region === "US" ? "USA" : (sourceConfig.indeed_country_names?.[countryName] || countryName),
          results_wanted: Number(sourceConfig.results_wanted || (region === "US" ? 200 : 100)),
          hours_old: Number(sourceConfig.hours_old || 72),
        });
      }
    }
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("JobSpy requires a fetch implementation");
  const baseUrl = String(options.baseUrl || process.env.JOBSPY_BASE_URL || "http://jobspy:8765").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs || Number(process.env.JOBSPY_TIMEOUT_MS) || 45 * 60 * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_HTTP_TIMEOUT_MS);
  options.log?.(`[${company}] source=jobspy`);
  options.log?.(`[${company}] retrieving ${searches.length} JobSpy searches`);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        searches,
        linkedin_jitter_seconds: sourceConfig.linkedin_jitter_seconds || [10, 20],
        proxies: sourceConfig.proxies || undefined,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`[${company}] JobSpy request failed: ${error.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error.message}`);
  } finally {
    clearTimeout(timeout);
  }
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`[${company}] JobSpy request failed: HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`[${company}] JobSpy response was invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(body.jobs) || !Array.isArray(body.diagnostics)) {
    throw new Error(`[${company}] JobSpy response is malformed`);
  }
  const jobs = body.jobs.map((job, index) => validateJob(job, company, index));
  options.log?.(`[${company}] normalized ${jobs.length} jobs`);
  for (const diagnostic of body.diagnostics) {
    options.log?.(
      `[${company}] ${diagnostic.site} ${JSON.stringify(diagnostic.search_term)} ${diagnostic.location || "all"}: ${diagnostic.normalized}/${diagnostic.returned} jobs in ${diagnostic.duration_seconds}s`,
    );
  }
  return jobs;
}
