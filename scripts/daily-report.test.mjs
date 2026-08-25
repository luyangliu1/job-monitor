#!/usr/bin/env node

import assert from "node:assert/strict";
import { formatDailyReport, formatDailyReportChunks } from "./daily-report.mjs";

assert.equal(
  formatDailyReport({ newPositionCount: 0, filteredOutCount: 3, errors: [], autoConfiguration: { needsReview: [] } }),
  "NO_REPLY",
);

const report = formatDailyReport({
  newPositionCount: 2,
  filteredOutCount: 1,
  filteredOutByReason: { senior: 1 },
  newJobsByCompany: [
    {
      company: "Example Co",
      positions: [
        { title: "Process Engineer", url: "https://jobs.example/process" },
        { title: "Lab [Engineer]", url: "" },
      ],
    },
  ],
  errors: [],
  autoConfiguration: { needsReview: [] },
});
assert.match(report, /^Found 2 new matching positions\./);
assert.match(report, /1 additional new opening was archived but filtered out \(1 senior\)\./);
assert.match(report, /Example Co\n• \[Process Engineer\]\(https:\/\/jobs\.example\/process\)/);
assert.ok(report.includes("• Lab \\[Engineer\\]"));

const partial = formatDailyReport({
  newPositionCount: 0,
  errors: [{ robotName: "Broken Co", error: "HTTP 500" }],
  autoConfiguration: { needsReview: [{ robotName: "New Co", reason: "Mapping required" }] },
});
assert.match(partial, /^Job scan was incomplete/);
assert.match(partial, /• Broken Co: HTTP 500/);
assert.match(partial, /• New Co: Mapping required/);

const manyPositions = Array.from({ length: 12 }, (_, index) => ({
  title: `Complete Position ${index + 1} END`,
  url: `https://jobs.example/${index + 1}`,
}));
const chunked = formatDailyReportChunks(
  {
    newPositionCount: manyPositions.length + 1,
    filteredOutCount: 0,
    newJobsByCompany: [
      { company: "Large Company", positions: manyPositions },
      { company: "Following Company", positions: [{ title: "Final Position", url: "https://jobs.example/final" }] },
    ],
    errors: [],
    autoConfiguration: { needsReview: [] },
  },
  260,
);
assert.ok(chunked.length > 2);
assert.ok(chunked.every((chunk) => chunk.length <= 260));
assert.ok(chunked.every((chunk) => !chunk.startsWith("• ") && !chunk.endsWith("•")));
assert.ok(chunked.some((chunk) => chunk.startsWith("Large Company (continued)\n")));
for (const position of [...manyPositions, { title: "Final Position" }]) {
  assert.equal(chunked.join("\n\n").split(position.title).length - 1, 1);
}
for (const line of chunked.flatMap((chunk) => chunk.split("\n")).filter((line) => line.startsWith("• "))) {
  assert.match(line, /^• \[[^\]]+\]\(https:\/\/[^)]+\)$/);
}

process.stdout.write("daily-report tests passed\n");
