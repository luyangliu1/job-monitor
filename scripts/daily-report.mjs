#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MONITOR_PATH = resolve(SCRIPT_DIR, "job-monitor.mjs");
const PIPELINE_PATH = resolve(SCRIPT_DIR, "job-pipeline.mjs");
const OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH || "/app/dist/index.js";
const TELEGRAM_SAFE_LIMIT = 3500;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function markdownLabel(value) {
  return cleanText(value).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function markdownUrl(value) {
  return cleanText(value).replace(/\)/g, "%29");
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

export function formatDailyReport(result) {
  const groups = Array.isArray(result?.newJobsByCompany) ? result.newJobsByCompany : [];
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const reviews = Array.isArray(result?.autoConfiguration?.needsReview)
    ? result.autoConfiguration.needsReview
    : [];
  const positionCount = Number(result?.newPositionCount ?? result?.newCount ?? 0);

  if (positionCount === 0 && errors.length === 0 && reviews.length === 0) return "NO_REPLY";

  const lines = [];
  if (positionCount > 0) {
    lines.push(`Found ${positionCount} new matching ${plural(positionCount, "position")}.`);
    const filteredCount = Number(result?.filteredOutCount || 0);
    if (filteredCount > 0) {
      const reasons = Object.entries(result?.filteredOutByReason || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => `${count} ${cleanText(reason)}`)
        .join(", ");
      lines.push(
        `${filteredCount} additional new ${plural(filteredCount, "opening")} ${plural(filteredCount, "was", "were")} archived but filtered out${reasons ? ` (${reasons})` : ""}.`,
      );
    }

    for (const group of groups) {
      const positions = Array.isArray(group?.positions) ? group.positions : [];
      if (positions.length === 0) continue;
      lines.push("", cleanText(group.company));
      for (const position of positions) {
        const title = markdownLabel(position?.title);
        const url = markdownUrl(position?.url);
        if (title) lines.push(url ? `• [${title}](${url})` : `• ${title}`);
      }
    }
  } else {
    lines.push("Job scan was incomplete; no reliable new-job report is available.");
  }

  if (errors.length > 0 || reviews.length > 0) {
    lines.push("", "Scan issues");
    for (const issue of [...errors, ...reviews]) {
      const name = cleanText(issue.robotName || issue.robotId || "Unknown robot");
      const detail = cleanText(issue.error || issue.reason || "Needs configuration review");
      lines.push(`• ${name}: ${detail}`);
    }
  }

  return lines.join("\n");
}

function splitOversizedBlock(block, maxLength) {
  if (block.length <= maxLength) return [block];
  const lines = block.split("\n");
  const heading = lines[0]?.startsWith("• ") ? "" : lines.shift() || "";
  const segments = [];
  let segment = heading;
  for (const line of lines) {
    const candidate = segment ? `${segment}\n${line}` : line;
    if (candidate.length <= maxLength) {
      segment = candidate;
      continue;
    }
    if (segment) segments.push(segment);
    segment = heading ? `${heading} (continued)\n${line}` : line;
    if (segment.length > maxLength) {
      throw new Error(`One report line exceeds the safe Telegram message limit (${maxLength} characters).`);
    }
  }
  if (segment) segments.push(segment);
  return segments;
}

export function formatDailyReportChunks(result, maxLength = TELEGRAM_SAFE_LIMIT) {
  if (!Number.isInteger(maxLength) || maxLength < 100) throw new Error("maxLength must be an integer of at least 100.");
  const report = formatDailyReport(result);
  if (report === "NO_REPLY") return [];
  const blocks = report.split("\n\n").flatMap((block) => splitOversizedBlock(block, maxLength));
  const chunks = [];
  let chunk = "";
  for (const block of blocks) {
    const candidate = chunk ? `${chunk}\n\n${block}` : block;
    if (candidate.length <= maxLength) {
      chunk = candidate;
      continue;
    }
    if (chunk) chunks.push(chunk);
    chunk = block;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function runJsonScript(path, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [path, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        if (!stdout.trim()) throw new Error(cleanText(stderr) || `monitor exited with status ${code}`);
        resolveResult(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not read ${path.split("/").at(-1)} result: ${error.message}`));
      }
    });
  });
}

function sendTelegramMessage(target, message) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [OPENCLAW_CLI_PATH, "message", "send", "--channel", "telegram", "--target", target, "--message", message, "--json"],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveResult(stdout);
      else reject(new Error(cleanText(stderr || stdout) || `Telegram sender exited with status ${code}`));
    });
  });
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  try {
    const startedAt = new Date().toISOString();
    const result = await runJsonScript(MONITOR_PATH, ["scan", "--all"]);
    const target = argumentValue(process.argv.slice(2), "--telegram-target") || process.env.MAXUN_JOB_REPORT_TELEGRAM_TARGET;
    const pipeline = await runJsonScript(PIPELINE_PATH, ["run", "--compatibility-since", startedAt]);
    const issues = [...(result.errors || []), ...(result.autoConfiguration?.needsReview || [])];
    let issueChunks = 0;
    if (target && issues.length > 0) {
      const issueResult = { ...result, newCount: 0, newPositionCount: 0, newJobsByCompany: [] };
      const chunks = formatDailyReportChunks(issueResult);
      for (const chunk of chunks) await sendTelegramMessage(target, chunk);
      issueChunks = chunks.length;
    }
    process.stdout.write(`${JSON.stringify({ status: pipeline.status, scan: result, pipeline, issueChunks }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Job monitor delivery failed: ${cleanText(error.message)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
