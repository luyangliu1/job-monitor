#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getJobs } from "./smartrecruiters.mjs";

const monitorPath = fileURLToPath(new URL("../job-monitor.mjs", import.meta.url));

const offsets = [];
const detailIds = [];
const paginatedJobs = await getJobs(
  {
    company: "Western Digital",
    source_config: { company_identifier: "WesternDigital", country: "us" },
  },
  {
    baseUrl: "https://api.test.invalid",
    detailConcurrency: 12,
    fetchImpl: async (input) => {
      const url = new URL(input);
      const detail = url.pathname.match(/\/postings\/(posting-\d+)$/);
      if (detail) {
        detailIds.push(detail[1]);
        return new Response(
          JSON.stringify({ postingUrl: `https://jobs.smartrecruiters.com/WesternDigital/${detail[1]}-role` }),
        );
      }
      assert.equal(url.searchParams.get("country"), "us");
      assert.equal(url.searchParams.get("destination"), "PUBLIC");
      assert.equal(url.searchParams.get("limit"), "100");
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      const count = offset === 0 ? 100 : offset === 100 ? 2 : 0;
      return new Response(
        JSON.stringify({
          limit: 100,
          offset,
          totalFound: 102,
          content: Array.from({ length: count }, (_, index) => {
            const id = `posting-${offset + index}`;
            return { id, name: `Role ${offset + index}`, ref: `https://api.test.invalid/ref/${id}` };
          }),
        }),
      );
    },
  },
);
assert.deepEqual(offsets, [0, 100]);
assert.equal(detailIds.length, 102);
assert.equal(paginatedJobs.length, 102);
assert.deepEqual(Object.keys(paginatedJobs[0]), ["name", "url", "description"]);
assert.deepEqual(paginatedJobs[0], {
  name: "Role 0",
  url: "https://jobs.smartrecruiters.com/WesternDigital/posting-0-role",
  description: "",
});
assert.ok(!paginatedJobs.some((job) => job.url.includes("api.test.invalid")));

await assert.rejects(
  getJobs(
    { company: "Broken Pagination", source_config: { company_identifier: "Broken", country: "us" } },
    {
      baseUrl: "https://api.test.invalid",
      fetchImpl: async (input) => {
        const offset = Number(new URL(input).searchParams.get("offset"));
        return new Response(
          JSON.stringify({
            totalFound: 101,
            content: offset === 0
              ? Array.from({ length: 100 }, (_, index) => ({ id: `id-${index}`, name: `Role ${index}` }))
              : [],
          }),
        );
      },
    },
  ),
  /empty page at offset 100/,
);

await assert.rejects(
  getJobs(
    { company: "Missing URL", source_config: { company_identifier: "Missing", country: "us" } },
    {
      baseUrl: "https://api.test.invalid",
      fetchImpl: async (input) => {
        const url = new URL(input);
        return url.pathname.endsWith("/one")
          ? new Response(JSON.stringify({ postingUrl: "" }))
          : new Response(JSON.stringify({ totalFound: 1, content: [{ id: "one", name: "One Role" }] }));
      },
    },
  ),
  /has no valid postingUrl/,
);

function runMonitor(args, env, expectedCode = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [monitorPath, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, expectedCode, stderr || stdout);
        resolve({ body: JSON.parse(stdout), stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

const root = mkdtempSync(join(tmpdir(), "smartrecruiters-monitor-"));
const configPath = join(root, "config.json");
const databasePath = join(root, "monitor.sqlite");
writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    outputLimit: 25,
    autoConfigure: false,
    robots: [
      {
        id: "legacy-maxun",
        name: "Legacy Maxun",
        itemsPath: "data.serializableOutput.scrapeList.List Data 1",
        fields: { title: "Label 1", url: "Label 2" },
        static: { company: "Legacy Co" },
      },
      {
        company: "Western Digital",
        source: "smartrecruiters",
        source_config: { company_identifier: "WesternDigital", country: "us" },
      },
    ],
  }),
);

let failList = false;
let allowMaxun = false;
let maxunRequestCount = 0;
const server = createServer((request, response) => {
  if (request.url.startsWith("/api/")) {
    maxunRequestCount += 1;
    if (!allowMaxun) {
      response.statusCode = 500;
      response.end("Maxun must not be called");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: {
        data: {
          listData: [
            { "Label 1": "Legacy Role", "Label 2": "https://jobs.example/legacy" },
          ],
        },
      },
    }));
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/v1/companies/WesternDigital/postings") {
    if (failList) {
      response.statusCode = 503;
      response.end("temporary outage");
      return;
    }
    assert.equal(url.searchParams.get("country"), "us");
    assert.equal(url.searchParams.get("destination"), "PUBLIC");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      totalFound: 2,
      content: [
        { id: "wd-1", name: "Process Engineer", ref: "do-not-use" },
        { id: "wd-2", name: "Equipment Engineer", ref: "do-not-use" },
      ],
    }));
    return;
  }
  const detail = url.pathname.match(/\/v1\/companies\/WesternDigital\/postings\/(wd-[12])$/);
  if (detail) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      postingUrl: `https://jobs.smartrecruiters.com/WesternDigital/${detail[1]}-job`,
    }));
    return;
  }
  response.statusCode = 404;
  response.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  const env = {
    MAXUN_JOB_MONITOR_CONFIG: configPath,
    MAXUN_JOB_MONITOR_DB: databasePath,
    MAXUN_API_KEY: "unused-test-key",
    MAXUN_BASE_URL: `http://127.0.0.1:${address.port}`,
    SMARTRECRUITERS_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const checked = await runMonitor(["config-check"], env);
  assert.deepEqual(checked.body.sourceCounts, { maxun: 1, smartrecruiters: 1, greenhouse: 0, jobspy: 0 });

  const baseline = await runMonitor(["baseline", "Western Digital"], env);
  assert.equal(baseline.body.status, "ok");
  assert.equal(baseline.body.source, "smartrecruiters-api");
  assert.deepEqual(baseline.body.jobSources, ["smartrecruiters"]);
  assert.equal(baseline.body.baselineCount, 2);
  assert.equal(baseline.body.robots[0].jobSource, "smartrecruiters");
  assert.equal(baseline.body.robots[0].sourcePath, "smartrecruiters-public-api");
  assert.equal(maxunRequestCount, 0);

  const legacyPayload = join(root, "legacy.json");
  writeFileSync(legacyPayload, JSON.stringify({
    data: { serializableOutput: { scrapeList: { "List Data 1": [
      { "Label 1": "Legacy Role", "Label 2": "https://jobs.example/legacy" },
    ] } } },
  }));
  const legacy = await runMonitor(["baseline", "Legacy Maxun", "--payload-file", legacyPayload], env);
  assert.equal(legacy.body.baselineCount, 1);
  assert.equal(legacy.body.robots[0].jobSource, "maxun");

  const beforeFailure = new DatabaseSync(databasePath);
  const currentBefore = beforeFailure.prepare(
    "SELECT COUNT(*) AS count FROM jobs WHERE robot_id = ? AND is_current = 1",
  ).get("smartrecruiters:WesternDigital:us").count;
  const scansBefore = beforeFailure.prepare(
    "SELECT COUNT(*) AS count FROM scans WHERE robot_id = ?",
  ).get("smartrecruiters:WesternDigital:us").count;
  beforeFailure.close();

  failList = true;
  const failed = await runMonitor(["scan", "Western Digital"], env, 2);
  assert.equal(failed.body.status, "error");
  assert.equal(failed.body.errors[0].jobSource, "smartrecruiters");
  assert.match(failed.body.errors[0].error, /HTTP 503/);
  assert.equal(maxunRequestCount, 0);

  const afterFailure = new DatabaseSync(databasePath);
  assert.equal(afterFailure.prepare(
    "SELECT COUNT(*) AS count FROM jobs WHERE robot_id = ? AND is_current = 1",
  ).get("smartrecruiters:WesternDigital:us").count, currentBefore);
  assert.equal(afterFailure.prepare(
    "SELECT COUNT(*) AS count FROM scans WHERE robot_id = ?",
  ).get("smartrecruiters:WesternDigital:us").count, scansBefore);
  afterFailure.close();

  failList = false;
  allowMaxun = true;
  const fullScan = await runMonitor(["scan", "--all"], env);
  assert.equal(fullScan.body.status, "ok");
  assert.equal(fullScan.body.source, "configured-sources");
  assert.deepEqual(fullScan.body.jobSources, ["maxun", "smartrecruiters"]);
  assert.equal(fullScan.body.robotCount, 2);
  assert.deepEqual(
    fullScan.body.robots.map((robot) => robot.jobSource),
    ["maxun", "smartrecruiters"],
  );
  assert.equal(maxunRequestCount, 1);
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

process.stdout.write("smartrecruiters source tests passed\n");
