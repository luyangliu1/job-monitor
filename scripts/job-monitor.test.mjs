#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptPath = fileURLToPath(new URL("./job-monitor.mjs", import.meta.url));

function run(args, env, expectedCode = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, expectedCode, stderr || stdout);
        assert.ok(stdout.trim(), stderr || `monitor returned no JSON for: ${args.join(" ")}`);
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runConfigError(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, 1, stderr);
        const jsonStart = stderr.indexOf("{");
        assert.ok(jsonStart >= 0, stderr);
        resolve(JSON.parse(stderr.slice(jsonStart)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function fixtureEnv(config) {
  const root = mkdtempSync(join(tmpdir(), "maxun-job-monitor-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return {
    root,
    env: {
      MAXUN_JOB_MONITOR_CONFIG: configPath,
      MAXUN_JOB_MONITOR_DB: join(root, "monitor.sqlite"),
    },
  };
}

const staticFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  robots: [
    {
      id: "configured-robot",
      name: "Envelope Test",
      itemsPath: "data.serializableOutput.scrapeList.List Data 1",
      fields: { title: "Job Title", url: "Job URL" },
      static: { company: "Envelope Co" },
    },
  ],
});
const storedPayloadPath = join(staticFixture.root, "stored.json");
writeFileSync(
  storedPayloadPath,
  JSON.stringify({
    data: {
      serializableOutput: {
        scrapeList: {
          "List Data 1": [{ "Job Title": "Existing Role", "Job URL": "https://jobs.example/existing-role" }],
        },
      },
    },
  }),
);
const storedBaseline = await run(
  ["baseline", "configured-robot", "--payload-file", storedPayloadPath],
  staticFixture.env,
);
assert.equal(storedBaseline.baselineCount, 1);
assert.equal(storedBaseline.robots[0].sourcePath, "data.serializableOutput.scrapeList.List Data 1");

const freshPayloadPath = join(staticFixture.root, "fresh.json");
writeFileSync(
  freshPayloadPath,
  JSON.stringify({
    data: {
      data: {
        listData: [
          { "Job Title": "Existing Role", "Job URL": "https://jobs.example/existing-role" },
          { "Job Title": "New Role", "Job URL": "https://jobs.example/new-role" },
          { "Job Title": "New Role", "Job URL": "https://jobs.example/new-role-second-opening" },
        ],
      },
    },
  }),
);
const freshScan = await run(["scan", "configured-robot", "--payload-file", freshPayloadPath], staticFixture.env);
assert.equal(freshScan.newCount, 2);
assert.equal(freshScan.newJobs[0].title, "New Role");
assert.equal(freshScan.newPositionCount, 1);
assert.deepEqual(freshScan.newJobsByCompany, [
  {
    company: "Envelope Co",
    positions: [{ title: "New Role", url: "https://jobs.example/new-role", urlIsFallback: false }],
  },
]);
assert.equal(freshScan.robots[0].sourcePath, "data.data.listData");

const missingUrlPayloadPath = join(staticFixture.root, "missing-url.json");
writeFileSync(
  missingUrlPayloadPath,
  JSON.stringify({ data: { data: { listData: [{ "Job Title": "Unsafe Identity" }] } } }),
);
const missingUrl = await run(
  ["scan", "configured-robot", "--payload-file", missingUrlPayloadPath],
  staticFixture.env,
  2,
);
assert.match(missingUrl.errors[0].error, /no fallback array matched the configured job title and URL fields/);

const multiListFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  robots: [
    {
      id: "multi-list-robot",
      name: "Multi List",
      itemsPath: [
        "data.serializableOutput.scrapeList.List Data 1",
        "data.serializableOutput.scrapeList.List Data 2",
      ],
      fields: { title: "Job Title", url: "Job URL" },
      static: { company: "Combined Co" },
    },
  ],
});
const multiListStoredPayload = join(multiListFixture.root, "multi-list-stored.json");
writeFileSync(
  multiListStoredPayload,
  JSON.stringify({
    data: {
      serializableOutput: {
        scrapeList: {
          "List Data 1": [
            { "Job Title": "Shared Role", "Job URL": "https://jobs.example/shared" },
            { "Job Title": "First List Role", "Job URL": "https://jobs.example/first" },
          ],
          "List Data 2": [
            { "Job Title": "Shared Role", "Job URL": "https://jobs.example/shared" },
            { "Job Title": "Second List Role", "Job URL": "https://jobs.example/second" },
          ],
        },
      },
    },
  }),
);
const multiListBaseline = await run(
  ["baseline", "multi-list-robot", "--payload-file", multiListStoredPayload],
  multiListFixture.env,
);
assert.equal(multiListBaseline.baselineCount, 3);
assert.equal(multiListBaseline.robots[0].duplicateCount, 1);
assert.equal(
  multiListBaseline.robots[0].sourcePath,
  "data.serializableOutput.scrapeList.List Data 1 + data.serializableOutput.scrapeList.List Data 2",
);

const multiListFreshPayload = join(multiListFixture.root, "multi-list-fresh.json");
writeFileSync(
  multiListFreshPayload,
  JSON.stringify({
    data: {
      data: {
        listData: {
          "List Data 1": [
            { "Job Title": "Shared Role", "Job URL": "https://jobs.example/shared" },
            { "Job Title": "First List Role", "Job URL": "https://jobs.example/first" },
            { "Job Title": "Fresh First Role", "Job URL": "https://jobs.example/fresh-first" },
          ],
          "List Data 2": [
            { "Job Title": "Shared Role", "Job URL": "https://jobs.example/shared" },
            { "Job Title": "Second List Role", "Job URL": "https://jobs.example/second" },
            { "Job Title": "Fresh Second Role", "Job URL": "https://jobs.example/fresh-second" },
          ],
        },
      },
    },
  }),
);
const multiListScan = await run(
  ["scan", "multi-list-robot", "--payload-file", multiListFreshPayload],
  multiListFixture.env,
);
assert.equal(multiListScan.discoveredNewCount, 2);
assert.equal(multiListScan.newCount, 2);
assert.equal(multiListScan.robots[0].duplicateCount, 1);
assert.equal(multiListScan.robots[0].sourcePath, "data.data.listData");
assert.deepEqual(
  multiListScan.newJobs.map((job) => job.title).sort(),
  ["Fresh First Role", "Fresh Second Role"],
);

const identityFixtureConfig = (withUrl) => ({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  robots: [
    {
      id: "identity-upgrade-robot",
      name: "Identity Upgrade",
      itemsPath: "jobs",
      fields: { title: "title", location: "location", ...(withUrl ? { url: "url" } : {}) },
      static: { company: "Identity Corp" },
    },
  ],
});
const identityFixture = fixtureEnv(identityFixtureConfig(false));
const identityBaselinePayload = join(identityFixture.root, "identity-baseline.json");
writeFileSync(
  identityBaselinePayload,
  JSON.stringify({ jobs: [{ title: "Process Engineer", location: "Austin, TX" }] }),
);
await run(["baseline", "identity-upgrade-robot", "--payload-file", identityBaselinePayload], identityFixture.env);
writeFileSync(identityFixture.env.MAXUN_JOB_MONITOR_CONFIG, JSON.stringify(identityFixtureConfig(true)));
const identityUrlPayload = join(identityFixture.root, "identity-url.json");
writeFileSync(
  identityUrlPayload,
  JSON.stringify({
    jobs: [{ title: "Process Engineer", location: "Austin, TX", url: "https://jobs.example/process-engineer" }],
  }),
);
const identityUpgrade = await run(
  ["scan", "identity-upgrade-robot", "--payload-file", identityUrlPayload],
  identityFixture.env,
);
assert.equal(identityUpgrade.identityUpgradeCount, 1);
assert.equal(identityUpgrade.discoveredNewCount, 0);
assert.equal(identityUpgrade.newCount, 0);
const identityStatus = await run(["status"], identityFixture.env);
assert.equal(identityStatus.totalStored, 1);
assert.equal(identityStatus.current, 1);

const filterFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  notificationFilters: {
    excludeTitlePatterns: [
      { reason: "senior", pattern: "\\b(?:senior|sr\\.?)\\b" },
      { reason: "principal", pattern: "\\bprincipal\\b" },
    ],
    includeTitlePatterns: [],
  },
  robots: [
    {
      id: "filter-robot",
      name: "Filter Test",
      itemsPath: "jobs",
      fields: { title: "Job Title", url: "Job URL" },
    },
  ],
});
const emptyFilterPayload = join(filterFixture.root, "empty.json");
writeFileSync(emptyFilterPayload, JSON.stringify({ jobs: [] }));
await run(["baseline", "filter-robot", "--payload-file", emptyFilterPayload], filterFixture.env);

const filterPayload = join(filterFixture.root, "filter.json");
writeFileSync(
  filterPayload,
  JSON.stringify({
    jobs: [
      { "Job Title": "Senior Process Engineer", "Job URL": "https://jobs.example/senior-process" },
      { "Job Title": "SENIOR Analyst", "Job URL": "https://jobs.example/senior-analyst" },
      { "Job Title": "Sr. Chemist", "Job URL": "https://jobs.example/sr-chemist" },
      { "Job Title": "Sriracha Quality Tester", "Job URL": "https://jobs.example/sriracha" },
      { "Job Title": "Junior Engineer", "Job URL": "https://jobs.example/junior" },
      { "Job Title": "Principal Scientist", "Job URL": "https://jobs.example/principal" },
    ],
  }),
);
const filtered = await run(["scan", "filter-robot", "--payload-file", filterPayload], filterFixture.env);
assert.equal(filtered.discoveredNewCount, 6);
assert.equal(filtered.filteredOutCount, 4);
assert.equal(filtered.newCount, 2);
assert.deepEqual(filtered.filteredOutByReason, { senior: 3, principal: 1 });
assert.deepEqual(
  filtered.newJobs.map((job) => job.title).sort(),
  ["Junior Engineer", "Sriracha Quality Tester"],
);

const filteredAgain = await run(["scan", "filter-robot", "--payload-file", filterPayload], filterFixture.env);
assert.equal(filteredAgain.discoveredNewCount, 0);
assert.equal(filteredAgain.filteredOutCount, 0);
assert.equal(filteredAgain.newCount, 0);
const filterPreview = await run(["filter-preview", "filter-robot"], filterFixture.env);
assert.equal(filterPreview.currentCount, 6);
assert.equal(filterPreview.wouldPassCount, 2);
assert.equal(filterPreview.filteredOutCount, 4);
const filteredHistory = await run(
  ["filtered-jobs", "filter-robot", "--since", "7d", "--limit", "10"],
  filterFixture.env,
);
assert.equal(filteredHistory.timeField, "recorded_at");
assert.equal(filteredHistory.filteredCount, 4);
assert.equal(filteredHistory.returnedCount, 4);
assert.deepEqual(filteredHistory.filteredOutByReason, { senior: 3, principal: 1 });
assert.ok(filteredHistory.filteredJobs.every((job) => job.recordedAt && job.filteredReason));
assert.equal(filteredHistory.filteredJobsByCompany[0].positions.length, 4);
const noFutureFilteredJobs = await run(
  ["filtered-jobs", "filter-robot", "--since", "2099-01-01T00:00:00Z"],
  filterFixture.env,
);
assert.equal(noFutureFilteredJobs.filteredCount, 0);
const filterStatus = await run(["status"], filterFixture.env);
assert.equal(filterStatus.missingRecordedAt, 0);
assert.deepEqual(filterStatus.notificationStatusCounts, { accepted: 2, filtered: 4 });

const legacyFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  notificationFilters: {
    excludeTitlePatterns: [{ reason: "senior", pattern: "\\bsenior\\b" }],
    includeTitlePatterns: [],
  },
  robots: [
    {
      id: "legacy-robot",
      name: "Legacy Robot",
      itemsPath: "jobs",
      fields: { title: "title", url: "url" },
      static: { company: "Legacy Co" },
    },
  ],
});
const legacyRecordedAt = new Date(Date.now() - 86_400_000).toISOString();
const legacyDb = new DatabaseSync(legacyFixture.env.MAXUN_JOB_MONITOR_DB);
legacyDb.exec(`
  CREATE TABLE jobs (
    robot_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    title TEXT NOT NULL COLLATE NOCASE,
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    job_date TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (robot_id, item_key)
  );
`);
legacyDb.prepare(`
  INSERT INTO jobs (
    robot_id, item_key, title, company, location, job_date, url, raw_json,
    first_seen_at, last_seen_at, is_current
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`).run(
  "legacy-robot",
  "legacy-key",
  "Senior Engineer",
  "Legacy Co",
  "",
  "",
  "https://jobs.example/legacy-senior",
  "{}",
  legacyRecordedAt,
  legacyRecordedAt,
);
legacyDb.close();
const migratedHistory = await run(
  ["filtered-jobs", "legacy-robot", "--since", "7d"],
  legacyFixture.env,
);
assert.equal(migratedHistory.backfilledDecisionCount, 1);
assert.equal(migratedHistory.filteredCount, 1);
assert.equal(migratedHistory.filteredJobs[0].recordedAt, legacyRecordedAt);
assert.equal(migratedHistory.filteredJobs[0].filterDecisionSource, "backfill");
const migratedDb = new DatabaseSync(legacyFixture.env.MAXUN_JOB_MONITOR_DB, { readOnly: true });
const migratedColumns = migratedDb.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
assert.ok(migratedColumns.includes("recorded_at"));
assert.equal(migratedDb.prepare("SELECT COUNT(*) AS count FROM jobs WHERE recorded_at = ''").get().count, 0);
migratedDb.close();

const inclusionFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  notificationFilters: {
    excludeTitlePatterns: [{ reason: "senior", pattern: "\\bsenior\\b" }],
    includeTitlePatterns: ["\\b(?:engineer|trainee)\\b"],
  },
  robots: [
    { id: "include-robot", name: "Include Test", itemsPath: "jobs", fields: { title: "title", url: "url" } },
    {
      id: "override-robot",
      name: "Override Test",
      itemsPath: "jobs",
      fields: { title: "title", url: "url" },
      notificationFilters: { excludeTitlePatterns: [] },
    },
  ],
});
const inclusionPayload = join(inclusionFixture.root, "inclusion.json");
writeFileSync(
  inclusionPayload,
  JSON.stringify({
    jobs: [
      { title: "Junior Engineer", url: "https://jobs.example/include-engineer" },
      { title: "Lab Technician", url: "https://jobs.example/include-tech" },
      { title: "Management Trainee", url: "https://jobs.example/include-trainee" },
      { title: "Senior Engineer", url: "https://jobs.example/include-senior" },
    ],
  }),
);
const included = await run(["scan", "include-robot", "--payload-file", inclusionPayload], inclusionFixture.env);
assert.equal(included.newCount, 2);
assert.deepEqual(included.filteredOutByReason, { "no-inclusion-match": 1, senior: 1 });
assert.ok(included.newJobs.some((job) => job.title === "Management Trainee"));

const overridePayload = join(inclusionFixture.root, "override.json");
writeFileSync(
  overridePayload,
  JSON.stringify({ jobs: [{ title: "Senior Engineer", url: "https://jobs.example/override-senior" }] }),
);
const overridden = await run(["scan", "override-robot", "--payload-file", overridePayload], inclusionFixture.env);
assert.equal(overridden.newCount, 1);
assert.equal(overridden.filteredOutCount, 0);

const invalidFixture = fixtureEnv({
  version: 1,
  autoConfigure: false,
  notificationFilters: {
    excludeTitlePatterns: [{ reason: "broken", pattern: "[" }],
    includeTitlePatterns: [],
  },
  robots: [],
});
const invalid = await runConfigError(["config-check"], invalidFixture.env);
assert.match(invalid.error, /invalid regular expression/);

const managedFilterFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  notificationFilters: {
    excludeTitlePatterns: [{ reason: "senior", pattern: "\\bsenior\\b" }],
    includeTitlePatterns: [],
  },
  robots: [
    { id: "managed-filter-robot", name: "Managed Filters", itemsPath: "jobs", fields: { title: "title", url: "url" } },
  ],
});
const initialManagedFilters = await run(["filter-list"], managedFilterFixture.env);
assert.deepEqual(initialManagedFilters.denyKeywords, ["senior"]);
assert.equal(initialManagedFilters.rules[0].source, "config");
const buyerAdded = await run(["filter-add", "buyer"], managedFilterFixture.env);
assert.equal(buyerAdded.action, "added");
assert.equal(buyerAdded.rule.reason, "buyer");
assert.equal(buyerAdded.rule.source, "managed");
assert.match("Buyer", new RegExp(buyerAdded.rule.pattern, "iu"));
assert.match("Buyers", new RegExp(buyerAdded.rule.pattern, "iu"));
assert.doesNotMatch("Buyership Analyst", new RegExp(buyerAdded.rule.pattern, "iu"));
const persistedManagedFilters = await run(["filter-list"], managedFilterFixture.env);
assert.deepEqual(persistedManagedFilters.denyKeywords, ["senior", "buyer"]);
assert.equal(persistedManagedFilters.managedOverrideCount, 1);
const managedFilterPayload = join(managedFilterFixture.root, "managed-filter.json");
writeFileSync(
  managedFilterPayload,
  JSON.stringify({
    jobs: [
      { title: "Strategic Buyer", url: "https://jobs.example/strategic-buyer" },
      { title: "Raw Materials Buyers", url: "https://jobs.example/material-buyers" },
      { title: "Buyership Analyst", url: "https://jobs.example/buyership" },
    ],
  }),
);
const managedFiltered = await run(
  ["scan", "managed-filter-robot", "--payload-file", managedFilterPayload],
  managedFilterFixture.env,
);
assert.equal(managedFiltered.filteredOutCount, 2);
assert.deepEqual(managedFiltered.filteredOutByReason, { buyer: 2 });
assert.equal(managedFiltered.newJobs[0].title, "Buyership Analyst");
const seniorRemoved = await run(["filter-remove", "senior"], managedFilterFixture.env);
assert.equal(seniorRemoved.action, "removed");
const filtersAfterRemoval = await run(["filter-list"], managedFilterFixture.env);
assert.deepEqual(filtersAfterRemoval.denyKeywords, ["buyer"]);
assert.deepEqual(filtersAfterRemoval.removedOverrides, ["senior"]);
const invalidManagedPattern = await runConfigError(
  ["filter-add", "broken", "--pattern", "["],
  managedFilterFixture.env,
);
assert.match(invalidManagedPattern.error, /invalid regular expression/);

const companyFilterFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  notificationFilters: {
    excludeTitlePatterns: [
      { reason: "senior", pattern: "\\b(?:senior|sr\\.?)\\b" },
      { reason: "manager", pattern: "\\bmanagers?\\b" },
    ],
    includeTitlePatterns: [],
  },
  robots: [
    {
      id: "entegris-robot",
      name: "Entegris",
      itemsPath: "jobs",
      fields: { title: "title", url: "url" },
      static: { company: "Entegris" },
    },
    {
      id: "other-company-robot",
      name: "Other Company",
      itemsPath: "jobs",
      fields: { title: "title", url: "url" },
      static: { company: "Other Company" },
    },
  ],
});
const companyExemption = await run(
  ["filter-exempt", "Entegris", "senior", "sr"],
  companyFilterFixture.env,
);
assert.equal(companyExemption.exemptedRules.length, 1);
assert.deepEqual(companyExemption.managedExemptions, ["senior"]);
assert.deepEqual(companyExemption.companyOverride.disabledExcludeReasons, ["senior"]);
assert.deepEqual(companyExemption.companyOverride.effectiveDenyKeywords, ["manager"]);
const companyFilterList = await run(["filter-list", "Entegris"], companyFilterFixture.env);
assert.deepEqual(companyFilterList.companyOverrides[0].disabledExcludeReasons, ["senior"]);
const companyFilterPayload = join(companyFilterFixture.root, "company-filter.json");
writeFileSync(
  companyFilterPayload,
  JSON.stringify({
    jobs: [
      { title: "Senior Process Engineer", url: "https://jobs.example/senior" },
      { title: "Sr. Process Engineer", url: "https://jobs.example/sr" },
      { title: "Process Engineering Manager", url: "https://jobs.example/manager" },
      { title: "Process Engineer", url: "https://jobs.example/engineer" },
    ],
  }),
);
const entegrisFiltered = await run(
  ["scan", "Entegris", "--payload-file", companyFilterPayload],
  companyFilterFixture.env,
);
assert.equal(entegrisFiltered.newCount, 3);
assert.equal(entegrisFiltered.filteredOutCount, 1);
assert.deepEqual(entegrisFiltered.filteredOutByReason, { manager: 1 });
const otherCompanyFiltered = await run(
  ["scan", "Other Company", "--payload-file", companyFilterPayload],
  companyFilterFixture.env,
);
assert.equal(otherCompanyFiltered.newCount, 1);
assert.equal(otherCompanyFiltered.filteredOutCount, 3);
assert.deepEqual(otherCompanyFiltered.filteredOutByReason, { senior: 2, manager: 1 });
const restoredCompanyFilter = await run(
  ["filter-restore", "Entegris", "sr"],
  companyFilterFixture.env,
);
assert.deepEqual(restoredCompanyFilter.managedExemptions, []);
assert.deepEqual(restoredCompanyFilter.companyOverride.effectiveDenyKeywords, ["senior", "manager"]);
const restoredPreview = await run(["filter-preview", "Entegris"], companyFilterFixture.env);
assert.equal(restoredPreview.filteredOutCount, 3);
assert.deepEqual(restoredPreview.filteredOutByReason, { senior: 2, manager: 1 });

const managedMappingFixture = fixtureEnv({
  version: 1,
  outputLimit: 25,
  autoConfigure: false,
  robots: [
    {
      id: "mapping-robot",
      name: "Mapping Test",
      itemsPath: "jobs",
      fields: { title: "Label 4", url: "Label 2", location: "Label 3" },
      static: { company: "Mapping Co" },
    },
  ],
});
const initialMapping = await run(["mapping-list", "Mapping Test"], managedMappingFixture.env);
assert.equal(initialMapping.mappings[0].source, "config");
assert.equal(initialMapping.mappings[0].fields.title, "Label 4");
const mappingSaved = await run(
  ["mapping-set", "Mapping Test", "--title", "Label 1"],
  managedMappingFixture.env,
);
assert.equal(mappingSaved.mapping.source, "managed");
assert.deepEqual(mappingSaved.mapping.fields, { title: "Label 1", url: "Label 2", location: "Label 3" });
const persistedMapping = await run(["mapping-list", "mapping-robot"], managedMappingFixture.env);
assert.equal(persistedMapping.mappings[0].source, "managed");
assert.equal(persistedMapping.mappings[0].fields.title, "Label 1");
const managedMappingPayload = join(managedMappingFixture.root, "managed-mapping.json");
writeFileSync(
  managedMappingPayload,
  JSON.stringify({
    jobs: [
      {
        "Label 1": "Correct Position Title",
        "Label 2": "https://jobs.example/correct-position",
        "Label 3": "Austin, TX",
        "Label 4": "JOB-123",
      },
    ],
  }),
);
const managedMappingScan = await run(
  ["scan", "Mapping Test", "--payload-file", managedMappingPayload],
  managedMappingFixture.env,
);
assert.equal(managedMappingScan.newJobs[0].title, "Correct Position Title");
const invalidMapping = await runConfigError(
  ["mapping-set", "Mapping Test", "--clear-title"],
  managedMappingFixture.env,
);
assert.match(invalidMapping.error, /must retain at least one title field/);
const mappingRemoved = await run(["mapping-remove", "Mapping Test"], managedMappingFixture.env);
assert.equal(mappingRemoved.mapping.source, "config");
assert.equal(mappingRemoved.mapping.fields.title, "Label 4");

const labelInferenceFixture = fixtureEnv({ version: 1, outputLimit: 25, autoConfigure: true, robots: [] });
async function syncLabelFixture(id, items) {
  const payloadPath = join(labelInferenceFixture.root, `${id}.json`);
  writeFileSync(
    payloadPath,
    JSON.stringify({ data: { serializableOutput: { scrapeList: { "List Data 1": items } } } }),
  );
  return run(["sync-config", id, "--payload-file", payloadPath], labelInferenceFixture.env);
}

const inferredTsmc = await syncLabelFixture("generic-tsmc", [
  {
    "Label 1": "EHS Engineer",
    "Label 2": "https://careers.example/JobDetail?jobId=22712",
    "Label 3": "More details",
    "Label 4": "Share",
    "Label 5": "USA-Arizona",
    "Label 6": "Posted: Aug 03, 2026",
  },
  {
    "Label 1": "Incoming Material QR Engineer",
    "Label 2": "https://careers.example/JobDetail?jobId=15367",
    "Label 3": "More details",
    "Label 4": "Share",
    "Label 5": "USA-Arizona",
    "Label 6": "Posted: Jul 30, 2026",
  },
  {
    "Label 1": "Equipment Technician",
    "Label 2": "https://careers.example/JobDetail?jobId=15368",
    "Label 3": "More details",
    "Label 4": "Share",
    "Label 5": "USA-Arizona",
    "Label 6": "Posted: Jul 29, 2026",
  },
]);
assert.equal(inferredTsmc.status, "ok");
assert.deepEqual(inferredTsmc.configured[0].fields, {
  title: "Label 1",
  url: "Label 2",
  location: "Label 5",
  date: "Label 6",
});
assert.equal(inferredTsmc.configured[0].baselineCount, 3);

const inferredLinde = await syncLabelFixture("generic-linde", [
  {
    "Label 1": "https://careers.example/requisition/32253",
    "Label 2": "Mgr, RC Maintenance",
    "Label 3": "2 Locations Available",
    "Label 4": "Posted on: 8/6/2026 - Application Deadline: -",
  },
  {
    "Label 1": "https://careers.example/requisition/32144",
    "Label 2": "Construction Site Administrator",
    "Label 3": "The Woodlands, TX",
    "Label 4": "Posted on: 8/6/2026 - Application Deadline: 8/11/2026",
  },
  {
    "Label 1": "https://careers.example/requisition/32268",
    "Label 2": "Operations Technician",
    "Label 3": "United States",
    "Label 4": "Posted on: 8/6/2026 - Application Deadline: -",
  },
]);
assert.deepEqual(inferredLinde.configured[0].fields, {
  title: "Label 2",
  url: "Label 1",
  location: "Label 3",
  date: "Label 4",
});

const inferredCellares = await syncLabelFixture("generic-cellares", [
  {
    "Label 1": "https://jobs.example/dffbdc42-0173-4396-b77f-8541dd4973e5",
    "Label 2": "Automation Equipment Engineer (I, II, III)",
    "Label 3": "ON-SITE —",
    "Label 4": "FULL TIME",
    "Label 5": "SOUTH SAN FRANCISCO, CA",
  },
  {
    "Label 1": "https://jobs.example/f405b648-cc28-4977-a62b-7700edccefea",
    "Label 2": "Senior Electrical Engineer (I, II, III)",
    "Label 3": "ON-SITE —",
    "Label 4": "FULL TIME",
    "Label 5": "SOUTH SAN FRANCISCO, CA",
  },
  {
    "Label 1": "https://jobs.example/e4ce8a78-1f74-44df-83b4-d728b3cc887d",
    "Label 2": "Director, Global Field Service Engineering",
    "Label 3": "ON-SITE —",
    "Label 4": "FULL TIME",
    "Label 5": "BRIDGEWATER, NJ",
  },
]);
assert.deepEqual(inferredCellares.configured[0].fields, {
  title: "Label 2",
  url: "Label 1",
  location: "Label 5",
});

const inferredAshby = await syncLabelFixture("generic-ashby", [
  {
    "Label 1": "https://jobs.example/340bd277-38b5-4cf8-a542-750a1e808ba3",
    "Label 2": "Global Sourcing Manager",
    "Label 3": "Commercial & Product • San Francisco HQ • Full time • On-site",
    "Label 4": "$150K – $170K • Offers Equity",
  },
  {
    "Label 1": "https://jobs.example/aaa1d4fd-4538-4a0a-a235-23d415179357",
    "Label 2": "Diamond/Core Driller",
    "Label 3": "Copper One • Moab, UT • Full time • On-site",
    "Label 4": "$25 – $45 per hour",
  },
  {
    "Label 1": "https://jobs.example/66359aa4-3677-41f8-a656-013d679a65c4",
    "Label 2": "Accounts Payable Manager",
    "Label 3": "Finance • Houston, TX • Full time • On-site",
    "Label 4": "$80K – $110K",
  },
  {
    "Label 1": "https://jobs.example/a538a091-92fc-4807-9575-8d940a2e443b",
    "Label 2": "Senior Technical Recruiter",
    "Label 3": "General • San Francisco HQ • Full time • On-site",
    "Label 4": "$100K – $160K • Offers Equity",
  },
  {
    "Label 1": "https://jobs.example/f77f0db0-fc53-4856-bd8f-9d08bbc69b7b",
    "Label 2": "Contract Building Information Modeling (BIM) Designer",
    "Label 3": "Plant & Process Engineering • Houston, TX; Remote • Contract • On-site",
    "Label 4": "",
  },
  {
    "Label 1": "https://jobs.example/34857c47-bde0-4dce-933b-f07291b5c999",
    "Label 2": "Analytical Applications Engineer",
    "Label 3": "Plant Operations • Moab, UT • Full time • On-site",
    "Label 4": "$85K – $100K • Offers Equity",
  },
  {
    "Label 1": "https://jobs.example/11b76624-5564-42a4-820b-16cc09563ff9",
    "Label 2": "Materials Engineer",
    "Label 3": "Process Development • San Francisco HQ • Full time • On-site",
    "Label 4": "$100K – $140K • Estimated Base Salary",
  },
  {
    "Label 1": "https://jobs.example/9e8fef14-ebf8-4298-906a-e08f6ae04cb4",
    "Label 2": "Product Designer, MarianaOS",
    "Label 3": "Product Development • San Francisco HQ • Full time • On-site",
    "Label 4": "$180K – $210K • Offers Equity",
  },
  {
    "Label 1": "https://jobs.example/d64c4408-8af6-47a9-916c-1b81705eaae2",
    "Label 2": "Construction Project Manager",
    "Label 3": "Project & Construction Management • Houston, TX • Full time • On-site",
    "Label 4": "",
  },
  {
    "Label 1": "https://jobs.example/44c92dd6-55f2-4e44-9360-bf4676466dac",
    "Label 2": "Machine Learning Engineer",
    "Label 3": "Software Development • Ann Arbor, MI; Houston, TX; San Francisco HQ • Full time • On-site",
    "Label 4": "$120K – $180K • Offers Equity",
  },
]);
assert.deepEqual(inferredAshby.configured[0].fields, {
  title: "Label 2",
  url: "Label 1",
  location: "Label 3",
});

const inferredAshbyWithoutUrls = await syncLabelFixture("generic-ashby-without-urls", [
  {
    "Label 1": "Fall 2026 R&D Engineering Intern – Hydrogen Systems",
    "Label 2": "",
    "Label 3": "Engineering • HQ • Intern • On-site",
  },
  {
    "Label 1": "Process Engineer",
    "Label 2": "",
    "Label 3": "Engineering • HQ • Full time • On-site",
  },
  {
    "Label 1": "Sr. Mechanical Engineer",
    "Label 2": "",
    "Label 3": "Engineering • HQ • Full time • On-site",
  },
]);
assert.deepEqual(inferredAshbyWithoutUrls.configured[0].fields, {
  title: "Label 1",
  location: "Label 3",
});
assert.equal(inferredAshbyWithoutUrls.configured[0].identityMode, "title+company+location");

const inferredAssetUrl = await syncLabelFixture("generic-asset-url", [
  {
    "Label 2": "https://cdn.example/media/company-logo.svg",
    "Label 3": "Full time",
    "Label 4": "Integrated Operations Technician",
    "Label 5": "Save Job",
    "Label 6": "United States of America | Boardman, United States of America",
    "Label 7": "4 days ago",
  },
  {
    "Label 2": "https://cdn.example/media/company-logo.svg",
    "Label 3": "Full time",
    "Label 4": "Process Computing/Cyber Specialist",
    "Label 5": "Save Job",
    "Label 6": "United States of America | Whiting, United States of America",
    "Label 7": "4 days ago",
  },
  {
    "Label 2": "https://cdn.example/media/company-logo.svg",
    "Label 3": "Full time",
    "Label 4": "Biofuels and Co-Processing Analyst",
    "Label 5": "Save Job",
    "Label 6": "United States of America | Chicago, United States of America",
    "Label 7": "10 days ago",
  },
]);
assert.deepEqual(inferredAssetUrl.configured[0].fields, {
  title: "Label 4",
  location: "Label 6",
  date: "Label 7",
});
assert.equal(inferredAssetUrl.configured[0].identityMode, "title+company+location");
assert.equal(inferredAssetUrl.configured[0].baselineCount, 3);

const inferredCargill = await syncLabelFixture("generic-cargill", [
  { "Label 2": "Food Safety Quality & Regulatory Associate", "Label 3": "Hazleton, Pennsylvania" },
  { "Label 2": "Senior Construction Supervisor", "Label 3": "Multiple Locations" },
  { "Label 2": "Production Planner", "Label 3": "Fremont, Nebraska" },
]);
assert.deepEqual(inferredCargill.configured[0].fields, { title: "Label 2", location: "Label 3" });
assert.equal(inferredCargill.configured[0].identityMode, "title+company+location");
assert.equal(inferredCargill.configured[0].baselineCount, 3);

const ambiguousLabels = await syncLabelFixture("ambiguous-labels", [
  { "Label 1": "Process Engineer", "Label 2": "Quality Specialist", "Label 3": "Austin, TX" },
  { "Label 1": "Process Technician", "Label 2": "Safety Coordinator", "Label 3": "Phoenix, AZ" },
  { "Label 1": "Process Manager", "Label 2": "Operations Analyst", "Label 3": "Portland, OR" },
]);
assert.equal(ambiguousLabels.status, "needs-review");
assert.equal(ambiguousLabels.configured.length, 0);
assert.equal(ambiguousLabels.needsReview.length, 1);

const liveFixture = fixtureEnv({ version: 1, outputLimit: 25, autoConfigure: true, robots: [] });
const robot = {
  recording_meta: {
    id: "new-robot",
    name: "TSMC-US",
    type: "scrape",
  },
  recording: { workflow: [{ where: { url: "https://careers.tsmc.example/jobs" } }] },
};
let executeCount = 0;
let runsCount = 0;
let failExecution = false;
let dropExecution = false;
let executeItems = [{ "Job Title": "Platform Engineer", "Job URL": "https://jobs.example/platform-engineer" }];
const server = createServer((request, response) => {
  if (request.url === "/api/sdk/robots") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [robot] }));
    return;
  }
  if (request.url === "/api/sdk/robots/new-robot/runs") {
    runsCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  if (request.url === "/api/sdk/robots/new-robot/execute") {
    executeCount += 1;
    if (dropExecution) {
      request.socket.destroy();
      return;
    }
    if (failExecution) {
      response.statusCode = 500;
      response.statusMessage = "Internal Server Error";
      response.setHeader("content-type", "text/plain");
      response.end("Run failed: extractor crashed");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: {
          listData: executeItems,
        },
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  const liveEnv = {
    ...liveFixture.env,
    MAXUN_API_KEY: "test-key",
    MAXUN_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const discovered = await run(["baseline", "--all", "--run"], liveEnv);
  assert.equal(executeCount, 1);
  assert.equal(runsCount, 0);
  assert.equal(discovered.autoConfiguration.configured.length, 1);
  assert.equal(discovered.autoConfiguration.configured[0].baselineCount, 1);
  assert.equal(discovered.autoConfiguration.configured[0].static.company, "TSMC");
  assert.equal(discovered.robots[0].autoBaselined, true);
  assert.equal(discovered.robots[0].itemCount, 1);

  const liveDb = new DatabaseSync(liveFixture.env.MAXUN_JOB_MONITOR_DB);
  liveDb.prepare("UPDATE jobs SET job_source='', region='' WHERE robot_id='new-robot'").run();
  liveDb.close();
  const refreshed = await run(["sync-config", "TSMC", "--latest"], liveEnv);
  assert.equal(refreshed.status, "ok");
  assert.equal(refreshed.checked, 1);
  const refreshedDb = new DatabaseSync(liveFixture.env.MAXUN_JOB_MONITOR_DB);
  assert.deepEqual(
    refreshedDb.prepare("SELECT DISTINCT job_source, region FROM jobs WHERE robot_id='new-robot'").all().map((row) => ({ ...row })),
    [{ job_source: "maxun", region: "US" }],
  );
  refreshedDb.close();
  const taggedMapping = await run(["mapping-list", "TSMC"], liveEnv);
  assert.equal(taggedMapping.mappings[0].id, "new-robot");

  robot.recording.workflow = [];
  executeItems = [
    { "Job Title": "Process Associate" },
    { "Job Title": "Manufacturing Associate" },
  ];
  const fallbackLinks = await run(["scan", "new-robot"], liveEnv);
  assert.equal(executeCount, 2);
  assert.equal(fallbackLinks.newCount, 2);
  assert.ok(fallbackLinks.newJobs.every((job) => job.url === "https://careers.tsmc.example/jobs"));
  assert.ok(fallbackLinks.newJobs.every((job) => job.urlIsFallback === true));
  assert.ok(
    fallbackLinks.newJobsByCompany[0].positions.every(
      (position) => position.url === "https://careers.tsmc.example/jobs" && position.urlIsFallback === true,
    ),
  );

  failExecution = true;
  const failed = await run(["scan", "new-robot"], liveEnv, 2);
  assert.equal(executeCount, 3);
  assert.match(failed.errors[0].error, /HTTP 500 Internal Server Error: Run failed: extractor crashed/);

  failExecution = false;
  dropExecution = true;
  const dropped = await run(["scan", "new-robot"], liveEnv, 2);
  assert.equal(executeCount, 4);
  assert.match(dropped.errors[0].error, /Maxun request failed: fetch failed \(.+\)/);
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const unknownMappingFixture = fixtureEnv({ version: 1, outputLimit: 25, autoConfigure: true, robots: [] });
const unknownRobot = {
  recording_meta: {
    id: "merl-intern-id",
    name: "MERL-intern",
    type: "scrape",
  },
  recording: { workflow: [{ where: { url: "https://careers.example/merl-intern" } }] },
};
const unknownMappingServer = createServer((request, response) => {
  if (request.url === "/api/sdk/robots") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [unknownRobot] }));
    return;
  }
  response.statusCode = 404;
  response.end("not found");
});
await new Promise((resolve) => unknownMappingServer.listen(0, "127.0.0.1", resolve));
try {
  const address = unknownMappingServer.address();
  const unknownMappingEnv = {
    ...unknownMappingFixture.env,
    MAXUN_API_KEY: "test-key",
    MAXUN_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const unsafeUnknownMapping = await runConfigError(
    ["mapping-set", "MERL-intern", "--title", "Label 2"],
    unknownMappingEnv,
  );
  assert.match(unsafeUnknownMapping.error, /must include a URL, job ID, or location field/);
  const unknownMappingSaved = await run(
    [
      "mapping-set",
      "MERL-intern",
      "--title",
      "Label 2",
      "--url",
      "Label 1",
      "--location",
      "Label 3",
      "--items-path",
      "data.serializableOutput.scrapeList.List Data 1",
      "--company",
      "MERL",
    ],
    unknownMappingEnv,
  );
  assert.equal(unknownMappingSaved.newlyDiscovered, true);
  assert.equal(unknownMappingSaved.mapping.id, "merl-intern-id");
  assert.equal(unknownMappingSaved.mapping.source, "managed");
  assert.deepEqual(unknownMappingSaved.mapping.fields, {
    title: "Label 2",
    url: "Label 1",
    location: "Label 3",
  });
  const unknownMappingListed = await run(["mapping-list", "MERL-intern"], unknownMappingEnv);
  assert.equal(unknownMappingListed.mappings[0].source, "managed");
  const unknownMappingPayload = join(unknownMappingFixture.root, "unknown-mapping.json");
  writeFileSync(
    unknownMappingPayload,
    JSON.stringify({
      data: {
        serializableOutput: {
          scrapeList: {
            "List Data 1": [
              {
                "Label 1": "https://careers.example/merl-intern/robotics-intern",
                "Label 2": "Robotics Research Intern",
                "Label 3": "Cambridge, MA",
              },
            ],
          },
        },
      },
    }),
  );
  const unknownBaseline = await run(
    ["baseline", "MERL-intern", "--payload-file", unknownMappingPayload],
    unknownMappingEnv,
  );
  assert.equal(unknownBaseline.baselineCount, 1);
  assert.equal(unknownBaseline.errors.length, 0);
  const unknownMappingRemoved = await run(["mapping-remove", "MERL-intern"], unknownMappingEnv);
  assert.equal(unknownMappingRemoved.restored, false);
  assert.equal(unknownMappingRemoved.mapping, null);
} finally {
  await new Promise((resolve, reject) =>
    unknownMappingServer.close((error) => (error ? reject(error) : resolve())),
  );
}

process.stdout.write("maxun-job-monitor tests passed\n");
