#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { extractBoardToken, getJobs } from "./greenhouse.mjs";

const monitorPath = fileURLToPath(new URL("../job-monitor.mjs", import.meta.url));

assert.equal(extractBoardToken("https://job-boards.greenhouse.io/skhynixamerica"), "skhynixamerica");
assert.equal(extractBoardToken("https://job-boards.greenhouse.io/skhynixamerica/"), "skhynixamerica");
assert.equal(extractBoardToken("https://boards.greenhouse.io/skhynixamerica"), "skhynixamerica");
assert.throws(() => extractBoardToken("https://example.com/skhynixamerica"), /Greenhouse board URL must use/);
assert.throws(() => extractBoardToken("https://job-boards.greenhouse.io/"), /does not contain a board token/);

let requestCount = 0;
const logs = [];
const normalized = await getJobs(
  {
    company: "SK hynix America",
    source_config: { board_url: "https://job-boards.greenhouse.io/skhynixamerica/" },
  },
  {
    baseUrl: "https://greenhouse.test.invalid",
    log: (message) => logs.push(message),
    fetchImpl: async (input) => {
      requestCount += 1;
      assert.equal(String(input), "https://greenhouse.test.invalid/v1/boards/skhynixamerica/jobs");
      return new Response(JSON.stringify({
        jobs: [
          {
            id: 1,
            title: "Process Integration Engineer",
            absolute_url: "https://job-boards.greenhouse.io/skhynixamerica/jobs/1",
            departments: [{ name: "Engineering" }],
          },
          {
            id: 2,
            title: "Financial Analyst",
            absolute_url: "https://job-boards.greenhouse.io/skhynixamerica/jobs/2",
            departments: [{ name: "Finance" }],
          },
          { id: 3, title: "Malformed Missing URL", departments: [{ name: "AI Research" }] },
        ],
      }));
    },
  },
);
assert.equal(requestCount, 1);
assert.deepEqual(normalized, [
  {
    name: "Process Integration Engineer",
    url: "https://job-boards.greenhouse.io/skhynixamerica/jobs/1",
  },
  {
    name: "Financial Analyst",
    url: "https://job-boards.greenhouse.io/skhynixamerica/jobs/2",
  },
]);
assert.deepEqual(Object.keys(normalized[0]), ["name", "url"]);
assert.ok(logs.some((message) => message.includes("board=skhynixamerica")));
assert.ok(logs.some((message) => message.includes("skipped 1 malformed")));

const empty = await getJobs(
  {
    company: "Empty Board",
    source_config: { board_url: "https://job-boards.greenhouse.io/emptyboard" },
  },
  { fetchImpl: async () => new Response(JSON.stringify({ jobs: [] })) },
);
assert.deepEqual(empty, []);

await assert.rejects(
  getJobs(
    {
      company: "Failed Board",
      source_config: { board_url: "https://job-boards.greenhouse.io/failedboard" },
    },
    { fetchImpl: async () => new Response("temporary outage", { status: 503 }) },
  ),
  /Greenhouse jobs request failed: HTTP 503/,
);
await assert.rejects(
  getJobs(
    {
      company: "Invalid Board",
      source_config: { board_url: "https://job-boards.greenhouse.io/invalidboard" },
    },
    { fetchImpl: async () => new Response(JSON.stringify({ data: [] })) },
  ),
  /jobs\[\] is missing/,
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

const root = mkdtempSync(join(tmpdir(), "greenhouse-monitor-"));
const configPath = join(root, "config.json");
const databasePath = join(root, "monitor.sqlite");
writeFileSync(configPath, JSON.stringify({
  version: 1,
  autoConfigure: false,
  robots: [
    {
      company: "SK hynix America",
      source: "greenhouse",
      source_config: { board_url: "https://job-boards.greenhouse.io/skhynixamerica" },
    },
  ],
}));

let failRetrieval = false;
let greenhouseRequests = 0;
let maxunRequests = 0;
const server = createServer((request, response) => {
  if (request.url.startsWith("/api/")) {
    maxunRequests += 1;
    response.statusCode = 500;
    response.end("Maxun must not be called");
    return;
  }
  if (request.url === "/v1/boards/skhynixamerica/jobs") {
    greenhouseRequests += 1;
    if (failRetrieval) {
      response.statusCode = 500;
      response.end("temporary Greenhouse failure");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jobs: [
      { title: "Process Engineer", absolute_url: "https://job-boards.greenhouse.io/skhynixamerica/jobs/10" },
      { title: "Equipment Engineer", absolute_url: "https://job-boards.greenhouse.io/skhynixamerica/jobs/11" },
    ] }));
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
    GREENHOUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const checked = await runMonitor(["config-check"], env);
  assert.deepEqual(checked.body.sourceCounts, { maxun: 0, smartrecruiters: 0, greenhouse: 1 });

  const baseline = await runMonitor(["baseline", "SK hynix America"], env);
  assert.equal(baseline.body.status, "ok");
  assert.equal(baseline.body.source, "greenhouse-api");
  assert.equal(baseline.body.baselineCount, 2);
  assert.equal(baseline.body.robots[0].robotId, "greenhouse:skhynixamerica");
  assert.equal(baseline.body.robots[0].jobSource, "greenhouse");
  assert.equal(baseline.body.robots[0].sourcePath, "greenhouse-job-board-api");
  assert.equal(greenhouseRequests, 1);
  assert.equal(maxunRequests, 0);

  const db = new DatabaseSync(databasePath);
  const stored = db.prepare(
    "SELECT raw_json, url FROM jobs WHERE robot_id = ? ORDER BY title",
  ).all("greenhouse:skhynixamerica");
  assert.equal(stored.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(stored[0].raw_json)), ["name", "url"]);
  const scansBefore = db.prepare(
    "SELECT COUNT(*) AS count FROM scans WHERE robot_id = ?",
  ).get("greenhouse:skhynixamerica").count;
  db.close();

  failRetrieval = true;
  const failed = await runMonitor(["scan", "SK hynix America"], env, 2);
  assert.equal(failed.body.status, "error");
  assert.equal(failed.body.errors[0].jobSource, "greenhouse");
  assert.match(failed.body.errors[0].error, /HTTP 500/);
  assert.equal(maxunRequests, 0);

  const afterFailure = new DatabaseSync(databasePath);
  assert.equal(afterFailure.prepare(
    "SELECT COUNT(*) AS count FROM jobs WHERE robot_id = ? AND is_current = 1",
  ).get("greenhouse:skhynixamerica").count, 2);
  assert.equal(afterFailure.prepare(
    "SELECT COUNT(*) AS count FROM scans WHERE robot_id = ?",
  ).get("greenhouse:skhynixamerica").count, scansBefore);
  afterFailure.close();
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

process.stdout.write("greenhouse source tests passed\n");
