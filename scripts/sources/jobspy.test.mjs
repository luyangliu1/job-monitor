#!/usr/bin/env node

import assert from "node:assert/strict";
import { getJobs } from "./jobspy.mjs";

let received;
const jobs = await getJobs(
  {
    company: "JobSpy US",
    region: "US",
    source_config: {
      keywords: ["process engineer", "chemical engineer"],
      sites: ["indeed", "linkedin"],
      results_wanted: 200,
      hours_old: 72,
      linkedin_jitter_seconds: [0, 0],
    },
  },
  {
    baseUrl: "http://jobspy.test.invalid",
    fetchImpl: async (_url, options) => {
      received = JSON.parse(options.body);
      return new Response(JSON.stringify({
        jobs: [{ name: "Process Engineer", url: "https://jobs.example/process", company: "Example", description: "One year experience" }],
        diagnostics: received.searches.map((search) => ({ ...search, returned: 1, normalized: 1, duration_seconds: 0.1 })),
      }));
    },
  },
);
assert.equal(received.searches.length, 4);
assert.deepEqual(received.searches.map((search) => [search.site, search.search_term]), [
  ["indeed", '"process engineer"'], ["linkedin", "process engineer"],
  ["indeed", '"chemical engineer"'], ["linkedin", "chemical engineer"],
]);
assert.ok(received.searches.every((search) => search.location === "United States" && search.hours_old === 72));
assert.deepEqual(jobs[0], {
  name: "Process Engineer", url: "https://jobs.example/process", company: "Example", location: "",
  description: "One year experience", date: "", site: "",
});

let rowSearches;
await getJobs(
  {
    company: "JobSpy ROW",
    region: "ROW",
    source_config: {
      keywords: ["chemical engineer"], sites: ["indeed", "linkedin"], countries: ["United Kingdom", "Czechia"],
      indeed_country_names: { "United Kingdom": "UK", Czechia: "Czech Republic" },
    },
  },
  { baseUrl: "http://jobspy.test.invalid", fetchImpl: async (_url, options) => {
    rowSearches = JSON.parse(options.body).searches;
    return new Response(JSON.stringify({ jobs: [], diagnostics: [] }));
  } },
);
assert.deepEqual(rowSearches.map((search) => [search.site, search.location, search.country_indeed]), [
  ["indeed", "United Kingdom", "UK"], ["linkedin", "United Kingdom", "UK"],
  ["indeed", "Czechia", "Czech Republic"], ["linkedin", "Czechia", "Czech Republic"],
]);

await assert.rejects(
  getJobs(
    { company: "Bad", region: "US", source_config: { keywords: ["x"], sites: ["indeed"] } },
    { fetchImpl: async () => new Response("rate limited", { status: 429 }) },
  ),
  /HTTP 429: rate limited/,
);

process.stdout.write("jobspy source tests passed\n");
