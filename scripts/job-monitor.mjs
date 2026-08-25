#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { extractBoardToken, getJobs as getGreenhouseJobs } from "./sources/greenhouse.mjs";
import { getJobs as getSmartRecruitersJobs } from "./sources/smartrecruiters.mjs";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.MAXUN_JOB_MONITOR_CONFIG || resolve(SKILL_DIR, "config.json");
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || resolve(SKILL_DIR, ".state");
const DB_PATH = process.env.MAXUN_JOB_MONITOR_DB || resolve(STATE_DIR, "maxun-job-monitor.sqlite");
const API_KEY = process.env.MAXUN_API_KEY || "";
const BASE_URL = (process.env.MAXUN_BASE_URL || "https://app.maxun.dev").replace(/\/+$/, "");
const API_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const SUPPORTED_JOB_SOURCES = new Set(["maxun", "smartrecruiters", "greenhouse"]);

const FIELD_ALIASES = {
  title: ["jobTitle", "title", "positionTitle", "position", "role", "jobName"],
  id: ["jobId", "requisitionId", "reqId", "postingId", "jobNumber", "id"],
  url: ["jobUrl", "applyUrl", "postingUrl", "jobLink", "url", "link", "href"],
  company: ["company", "companyName", "employer", "organization", "organisation"],
  location: ["jobLocation", "location", "workplace", "city", "address"],
  date: ["datePosted", "postedDate", "postingDate", "publishedAt", "published", "date"],
};

function fail(message, nextAction, details) {
  const body = { status: "error", error: message };
  if (nextAction) body.nextAction = nextAction;
  if (details !== undefined) body.details = details;
  process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exit(1);
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${label} at ${path}: ${error.message}`, `Fix ${path} and retry.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function jobSourceFor(robot) {
  return String(robot.source || "maxun").toLowerCase();
}

function companyForRobot(robot) {
  return scalar(robot.company) || scalar(robot.static?.company) || scalar(robot.name) || scalar(robot.id);
}

function normalizeConfiguredRobot(robot, index) {
  if (!isRecord(robot)) {
    fail(`robots[${index}] must be an object.`, `Fix ${CONFIG_PATH} and retry.`);
  }
  const source = jobSourceFor(robot);
  if (!SUPPORTED_JOB_SOURCES.has(source)) {
    fail(
      `robots[${index}].source '${robot.source}' is not supported.`,
      `Use ${[...SUPPORTED_JOB_SOURCES].map((value) => `'${value}'`).join(", ")}.`,
    );
  }
  if (source === "maxun") {
    const configuredRobotId = scalar(robot.source_config?.robot_id);
    const id = scalar(robot.id) || configuredRobotId;
    if (!id) {
      fail(
        `robots[${index}] must contain id or source_config.robot_id for source=maxun.`,
        `Fix ${CONFIG_PATH} and retry.`,
      );
    }
    if (configuredRobotId && scalar(robot.id) && configuredRobotId !== scalar(robot.id)) {
      fail(
        `robots[${index}] has conflicting id and source_config.robot_id values.`,
        "A company must use exactly one Maxun robot ID.",
      );
    }
    return { ...robot, id };
  }

  const company = companyForRobot(robot);
  const sourceConfig = robot.source_config;
  if (!company) {
    fail(`robots[${index}].company is required for source=${source}.`, `Fix ${CONFIG_PATH} and retry.`);
  }
  if (!isRecord(sourceConfig)) {
    fail(`robots[${index}].source_config is required for source=${source}.`, `Fix ${CONFIG_PATH} and retry.`);
  }
  if (robot.itemsPath !== undefined || robot.fields !== undefined || robot.identityFields !== undefined) {
    fail(
      `robots[${index}] cannot contain Maxun field mappings when source=${source}.`,
      "Remove itemsPath, fields, and identityFields; the source adapter returns name and url.",
    );
  }
  const common = {
    ...robot,
    name: scalar(robot.name) || company,
    company,
    source,
    fields: { title: "name", url: "url" },
    static: { ...(robot.static || {}), company },
  };
  if (source === "smartrecruiters") {
    const companyIdentifier = scalar(sourceConfig.company_identifier);
    const country = scalar(sourceConfig.country).toLowerCase();
    if (!companyIdentifier || !country) {
      fail(
        `robots[${index}].source_config must contain company_identifier and country.`,
        `Fix ${CONFIG_PATH} and retry.`,
      );
    }
    return {
      ...common,
      id: scalar(robot.id) || `smartrecruiters:${companyIdentifier}:${country}`,
      source_config: { ...sourceConfig, company_identifier: companyIdentifier, country },
    };
  }
  if (source === "greenhouse") {
    const boardUrl = scalar(sourceConfig.board_url);
    let boardToken;
    try {
      boardToken = extractBoardToken(boardUrl);
    } catch (error) {
      fail(`robots[${index}].source_config.board_url is invalid: ${error.message}`, `Fix ${CONFIG_PATH} and retry.`);
    }
    return {
      ...common,
      id: scalar(robot.id) || `greenhouse:${boardToken.toLowerCase()}`,
      source_config: { ...sourceConfig, board_url: boardUrl },
    };
  }
  fail(`Unsupported job source: ${source}`);
}

function scalar(value) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).trim();
  if (Array.isArray(value)) {
    return value.map(scalar).filter(Boolean).join(", ");
  }
  if (isRecord(value)) {
    for (const key of ["text", "value", "label", "name", "content", "href", "url"]) {
      const match = Object.keys(value).find((candidate) => normalizeKey(candidate) === normalizeKey(key));
      if (match) {
        const result = scalar(value[match]);
        if (result) return result;
      }
    }
  }
  return "";
}

function valueAtPath(root, path) {
  let current = root;
  for (const segment of String(path).split(".").filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    const key = Object.keys(current).find((candidate) => normalizeKey(candidate) === normalizeKey(segment));
    if (!key) return undefined;
    current = current[key];
  }
  return current;
}

function configuredPaths(robot, field) {
  const configured = robot.fields?.[field];
  if (typeof configured === "string") return [configured];
  if (Array.isArray(configured)) return configured.filter((value) => typeof value === "string");
  return [];
}

function findAliasedValue(root, aliases, depth = 0) {
  if (!isRecord(root) || depth > 3) return "";
  const normalizedAliases = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(root)) {
    if (normalizedAliases.has(normalizeKey(key))) {
      const result = scalar(value);
      if (result) return result;
    }
  }
  for (const value of Object.values(root)) {
    if (isRecord(value)) {
      const result = findAliasedValue(value, aliases, depth + 1);
      if (result) return result;
    }
  }
  return "";
}

function fieldValue(item, robot, field) {
  for (const path of configuredPaths(robot, field)) {
    const result = scalar(valueAtPath(item, path));
    if (result) return result;
  }
  return findAliasedValue(item, FIELD_ALIASES[field] || []);
}

function arraysOfRecords(root) {
  const candidates = [];
  const visit = (value, path, depth) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      if (value.length === 0 || value.some(isRecord)) {
        candidates.push({ path, items: value.filter(isRecord) });
      }
      value.forEach((entry, index) => {
        if (isRecord(entry) || Array.isArray(entry)) visit(entry, `${path}.${index}`, depth + 1);
      });
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  visit(root, "", 0);
  return candidates;
}

function toItemArray(value) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return null;
  const arrays = Object.values(value).filter(Array.isArray);
  if (arrays.length === 1) return arrays[0].filter(isRecord);
  if (arrays.length > 1) return arrays.flatMap((items) => items.filter(isRecord));
  return null;
}

function configuredItemPaths(robot) {
  if (typeof robot.itemsPath === "string") return [robot.itemsPath];
  if (Array.isArray(robot.itemsPath)) return robot.itemsPath;
  return [];
}

function selectItems(payload, robot) {
  let configuredPathError = "";
  const expectsConfiguredTitle = configuredPaths(robot, "title").length > 0;
  const expectsConfiguredUrl = configuredPaths(robot, "url").length > 0;
  const itemPaths = configuredItemPaths(robot);
  if (itemPaths.length > 0) {
    const selections = itemPaths.map((path) => ({ path, items: toItemArray(valueAtPath(payload, path)) }));
    const missingPaths = selections.filter((selection) => selection.items === null).map((selection) => selection.path);
    if (missingPaths.length === 0) {
      return {
        path: itemPaths.join(" + "),
        paths: itemPaths,
        items: selections.flatMap((selection) => selection.items),
      };
    }
    configuredPathError = `itemsPath does not resolve to an item array: ${missingPaths.map((path) => `'${path}'`).join(", ")}`;
  }

  // Fresh /execute responses use this envelope. listData may itself contain
  // multiple named arrays, so flatten them before the generic candidate scan.
  const freshPath = "data.data.listData";
  const freshItems = toItemArray(valueAtPath(payload, freshPath));
  const freshSample = freshItems?.slice(0, 20) || [];
  const freshTitleMatches = freshSample.filter((item) => fieldValue(item, robot, "title")).length;
  const freshUrlMatches = freshSample.filter((item) => validHttpUrl(fieldValue(item, robot, "url"))).length;
  const freshPairedMatches = freshSample.filter(
    (item) => fieldValue(item, robot, "title") && validHttpUrl(fieldValue(item, robot, "url")),
  ).length;
  const freshMatches =
    freshItems?.length === 0 ||
    (freshTitleMatches > 0 &&
      (!expectsConfiguredUrl || freshUrlMatches > 0) &&
      (!expectsConfiguredTitle || !expectsConfiguredUrl || freshPairedMatches > 0));
  if (freshItems !== null && freshMatches) {
    return { path: freshPath, paths: [freshPath], items: freshItems };
  }

  const candidates = arraysOfRecords(payload).map((candidate) => {
    const sampled = candidate.items.slice(0, 20);
    const titleMatches = sampled.filter((item) => fieldValue(item, robot, "title")).length;
    const urlMatches = sampled.filter((item) => validHttpUrl(fieldValue(item, robot, "url"))).length;
    const pairedMatches = sampled.filter(
      (item) => fieldValue(item, robot, "title") && validHttpUrl(fieldValue(item, robot, "url")),
    ).length;
    return {
      ...candidate,
      titleMatches,
      urlMatches,
      pairedMatches,
      score: pairedMatches * 1_000_000 + titleMatches * 1000 + urlMatches * 100 + candidate.items.length,
    };
  });
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const best = candidates.find(
    (candidate) =>
      candidate.titleMatches > 0 &&
      (!expectsConfiguredTitle || candidate.titleMatches > 0) &&
      (!expectsConfiguredUrl || candidate.urlMatches > 0) &&
      (!expectsConfiguredTitle || !expectsConfiguredUrl || candidate.pairedMatches > 0),
  );
  if (!best) {
    const suffix = configuredPathError ? `${configuredPathError}; ` : "";
    throw new Error(`${suffix}no fallback array matched the configured job title and URL fields`);
  }
  return { path: best.path, items: best.items };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function canonicalUrl(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw.trim();
  }
}

function semanticIdentity(job) {
  return [job.title, job.company, job.location].map((value) => String(value || "").toLowerCase()).join("\u0000");
}

function identityFor(item, job, robot) {
  const configured = Array.isArray(robot.identityFields) ? robot.identityFields : [];
  const configuredValues = configured.map((path) => scalar(valueAtPath(item, path))).filter(Boolean);
  if (configured.length > 0 && configuredValues.length === configured.length) {
    return `fields:${configuredValues.map((value) => value.toLowerCase()).join("\u0000")}`;
  }
  if (job.id) return `id:${job.id.toLowerCase()}`;
  if (job.url) return `url:${canonicalUrl(job.url)}`;
  return `semantic:${semanticIdentity(job)}`;
}

function normalizeJobs(items, robot) {
  const skipped = [];
  const unique = new Map();
  for (const [index, item] of items.entries()) {
    const title = fieldValue(item, robot, "title");
    if (!title) {
      skipped.push({ index, fields: Object.keys(item).slice(0, 20) });
      continue;
    }
    const job = {
      title,
      company: scalar(robot.static?.company) || fieldValue(item, robot, "company"),
      location: scalar(robot.static?.location) || fieldValue(item, robot, "location"),
      date: fieldValue(item, robot, "date"),
      url: canonicalUrl(fieldValue(item, robot, "url")),
      id: fieldValue(item, robot, "id"),
      raw: stableValue(item),
    };
    const identity = identityFor(item, job, robot);
    const itemKey = createHash("sha256").update(`${robot.id}\u0000${identity}`).digest("hex");
    unique.set(itemKey, { ...job, itemKey });
  }
  return { jobs: [...unique.values()], skipped, duplicateCount: items.length - skipped.length - unique.size };
}

const NOTIFICATION_FILTER_KEYS = ["excludeTitlePatterns", "includeTitlePatterns", "disabledExcludeReasons"];

function validateRegex(pattern, label) {
  try {
    new RegExp(pattern, "iu");
  } catch (error) {
    fail(`${label} contains invalid regular expression '${pattern}': ${error.message}`, `Fix ${CONFIG_PATH} and retry.`);
  }
}

function validateNotificationFilters(filters, label) {
  if (filters === undefined) return;
  if (!isRecord(filters)) fail(`${label} must be an object.`, `Fix ${CONFIG_PATH} and retry.`);
  for (const key of Object.keys(filters)) {
    if (!NOTIFICATION_FILTER_KEYS.includes(key)) {
      fail(`${label}.${key} is not supported.`, `Use only ${NOTIFICATION_FILTER_KEYS.join(" and ")}.`);
    }
  }
  if (filters.excludeTitlePatterns !== undefined) {
    if (!Array.isArray(filters.excludeTitlePatterns)) {
      fail(`${label}.excludeTitlePatterns must be an array.`, `Fix ${CONFIG_PATH} and retry.`);
    }
    const reasons = new Set();
    for (const [index, rule] of filters.excludeTitlePatterns.entries()) {
      if (!isRecord(rule) || typeof rule.reason !== "string" || !rule.reason.trim() || typeof rule.pattern !== "string" || !rule.pattern) {
        fail(`${label}.excludeTitlePatterns[${index}] must contain non-empty reason and pattern strings.`, `Fix ${CONFIG_PATH} and retry.`);
      }
      if (reasons.has(rule.reason)) fail(`${label}.excludeTitlePatterns has duplicate reason '${rule.reason}'.`);
      reasons.add(rule.reason);
      validateRegex(rule.pattern, `${label}.excludeTitlePatterns[${index}].pattern`);
    }
  }
  if (filters.includeTitlePatterns !== undefined) {
    if (
      !Array.isArray(filters.includeTitlePatterns) ||
      filters.includeTitlePatterns.some((pattern) => typeof pattern !== "string" || !pattern)
    ) {
      fail(`${label}.includeTitlePatterns must be an array of non-empty regular-expression strings.`, `Fix ${CONFIG_PATH} and retry.`);
    }
    filters.includeTitlePatterns.forEach((pattern, index) =>
      validateRegex(pattern, `${label}.includeTitlePatterns[${index}]`),
    );
  }
  if (filters.disabledExcludeReasons !== undefined) {
    if (
      !Array.isArray(filters.disabledExcludeReasons) ||
      filters.disabledExcludeReasons.some((reason) => typeof reason !== "string" || !reason.trim())
    ) {
      fail(`${label}.disabledExcludeReasons must be an array of non-empty reason strings.`, `Fix ${CONFIG_PATH} and retry.`);
    }
    const normalized = filters.disabledExcludeReasons.map((reason) => normalizeFilterReason(reason));
    if (normalized.some((reason) => !reason) || new Set(normalized).size !== normalized.length) {
      fail(`${label}.disabledExcludeReasons must contain unique valid reason strings.`, `Fix ${CONFIG_PATH} and retry.`);
    }
  }
}

function effectiveNotificationFilters(config, robot) {
  const globalFilters = config.notificationFilters || {};
  const robotFilters = robot.notificationFilters || {};
  const disabledExcludeReasons = new Set(
    [...(globalFilters.disabledExcludeReasons || []), ...(robotFilters.disabledExcludeReasons || [])]
      .map((reason) => normalizeFilterReason(reason)),
  );
  const excludeTitlePatterns = Object.hasOwn(robotFilters, "excludeTitlePatterns")
    ? robotFilters.excludeTitlePatterns
    : globalFilters.excludeTitlePatterns || [];
  return {
    excludeTitlePatterns: excludeTitlePatterns.filter(
      (rule) => !disabledExcludeReasons.has(normalizeFilterReason(rule.reason)),
    ),
    includeTitlePatterns: Object.hasOwn(robotFilters, "includeTitlePatterns")
      ? robotFilters.includeTitlePatterns
      : globalFilters.includeTitlePatterns || [],
    disabledExcludeReasons: [...disabledExcludeReasons],
  };
}

function loadManagedFilterOverrides(db) {
  return db
    .prepare(`
      SELECT reason, action, pattern, updated_at
      FROM notification_filter_overrides
      ORDER BY updated_at, reason COLLATE NOCASE
    `)
    .all();
}

function configWithManagedFilterOverrides(config, db) {
  const rules = new Map(
    (config.notificationFilters?.excludeTitlePatterns || []).map((rule) => [rule.reason.toLowerCase(), { ...rule }]),
  );
  for (const override of loadManagedFilterOverrides(db)) {
    const reason = override.reason.toLowerCase();
    if (override.action === "remove") rules.delete(reason);
    else rules.set(reason, { reason: override.reason, pattern: override.pattern });
  }
  const merged = {
    ...config,
    notificationFilters: {
      ...(config.notificationFilters || {}),
      excludeTitlePatterns: [...rules.values()],
    },
  };
  validateNotificationFilters(merged.notificationFilters, "effective notificationFilters");
  return merged;
}

function normalizeFilterReason(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pluralizeKeywordWord(word) {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

function defaultDenyPattern(keyword) {
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  const finalWord = words.pop();
  const singular = regexEscape(finalWord);
  const plural = regexEscape(pluralizeKeywordWord(finalWord));
  const prefix = words.length > 0 ? `${words.map(regexEscape).join("\\s+")}\\s+` : "";
  return `\\b${prefix}(?:${singular}|${plural})\\b`;
}

function managedFilterSummary(baseConfig, effectiveConfig, db) {
  const baseReasons = new Set(
    (baseConfig.notificationFilters?.excludeTitlePatterns || []).map((rule) => rule.reason.toLowerCase()),
  );
  const overrides = loadManagedFilterOverrides(db);
  const upserted = new Set(overrides.filter((row) => row.action === "upsert").map((row) => row.reason.toLowerCase()));
  const rules = (effectiveConfig.notificationFilters?.excludeTitlePatterns || []).map((rule) => ({
    ...rule,
    source: upserted.has(rule.reason.toLowerCase()) ? "managed" : baseReasons.has(rule.reason.toLowerCase()) ? "config" : "managed",
  }));
  return {
    rules,
    denyKeywords: rules.map((rule) => rule.reason),
    managedOverrideCount: overrides.length,
    removedOverrides: overrides.filter((row) => row.action === "remove").map((row) => row.reason),
  };
}

function setManagedFilterOverride(db, reason, action, pattern = "") {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO notification_filter_overrides (reason, action, pattern, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(reason) DO UPDATE SET
      action = excluded.action,
      pattern = excluded.pattern,
      updated_at = excluded.updated_at
  `).run(reason, action, pattern, now);
  return now;
}

function loadRobotFilterExemptions(db, robotId) {
  const rows = robotId
    ? db.prepare(`
        SELECT robot_id, reason, updated_at
        FROM robot_filter_exemptions
        WHERE robot_id = ?
        ORDER BY reason COLLATE NOCASE
      `).all(robotId)
    : db.prepare(`
        SELECT robot_id, reason, updated_at
        FROM robot_filter_exemptions
        ORDER BY robot_id COLLATE NOCASE, reason COLLATE NOCASE
      `).all();
  return rows;
}

function setRobotFilterExemption(db, robotId, reason) {
  const updatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO robot_filter_exemptions (robot_id, reason, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(robot_id, reason) DO UPDATE SET updated_at = excluded.updated_at
  `).run(robotId, reason, updatedAt);
  return updatedAt;
}

function filterRulesBeforeExemptions(config, robot) {
  return effectiveNotificationFilters(config, {
    ...robot,
    notificationFilters: {
      ...(robot.notificationFilters || {}),
      disabledExcludeReasons: [],
    },
  }).excludeTitlePatterns;
}

function resolveRequestedFilterReason(config, robot, requested) {
  const normalized = normalizeFilterReason(requested);
  const rules = filterRulesBeforeExemptions(config, robot);
  const exact = rules.find((rule) => normalizeFilterReason(rule.reason) === normalized);
  if (exact) return exact;
  const matches = rules.filter((rule) => new RegExp(rule.pattern, "iu").test(String(requested).trim()));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(
      `Filter keyword '${requested}' matches more than one deny rule.`,
      `Retry with one of these rule reasons: ${matches.map((rule) => rule.reason).join(", ")}.`,
    );
  }
  fail(`No active deny filter matches '${requested}'.`, "Run 'filter-list' to see active rule reasons.");
}

function publicCompanyFilterOverride(config, robot) {
  const effective = effectiveNotificationFilters(config, robot);
  return {
    robotId: robot.id,
    robotName: robot.name || robot.id,
    company: scalar(robot.static?.company) || robot.name || robot.id,
    disabledExcludeReasons: effective.disabledExcludeReasons,
    effectiveDenyKeywords: effective.excludeTitlePatterns.map((rule) => rule.reason),
  };
}

function filterNewJobs(jobs, config, robot) {
  const filters = effectiveNotificationFilters(config, robot);
  const exclusions = filters.excludeTitlePatterns.map((rule) => ({
    reason: rule.reason,
    expression: new RegExp(rule.pattern, "iu"),
  }));
  const inclusions = filters.includeTitlePatterns.map((pattern) => new RegExp(pattern, "iu"));
  const accepted = [];
  const filteredOut = [];
  const filteredOutByReason = {};
  for (const job of jobs) {
    const exclusion = exclusions.find(({ expression }) => expression.test(job.title));
    let reason = exclusion?.reason || "";
    if (!reason && inclusions.length > 0 && !inclusions.some((expression) => expression.test(job.title))) {
      reason = "no-inclusion-match";
    }
    if (reason) {
      filteredOut.push({ job, reason });
      filteredOutByReason[reason] = (filteredOutByReason[reason] || 0) + 1;
    } else {
      accepted.push(job);
    }
  }
  return { accepted, filteredOut, filteredOutCount: filteredOut.length, filteredOutByReason };
}

function recordNotificationDecisions(db, robotId, filtered, evaluatedAt, source) {
  const update = db.prepare(`
    UPDATE jobs SET
      notification_status = ?,
      filtered_reason = ?,
      filter_evaluated_at = ?,
      filter_decision_source = ?
    WHERE robot_id = ? AND item_key = ?
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const job of filtered.accepted) {
      update.run("accepted", "", evaluatedAt, source, robotId, job.itemKey);
    }
    for (const { job, reason } of filtered.filteredOut) {
      update.run("filtered", reason, evaluatedAt, source, robotId, job.itemKey);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function loadConfig() {
  const config = parseJsonFile(CONFIG_PATH, "monitor configuration");
  if (config.version !== 1 || !Array.isArray(config.robots)) {
    fail("Configuration must contain version 1 and a robots array.", `Fix ${CONFIG_PATH} and retry.`);
  }
  config.robots = config.robots.map(normalizeConfiguredRobot);
  validateNotificationFilters(config.notificationFilters, "notificationFilters");
  const ids = new Set();
  const companySources = new Map();
  for (const [index, robot] of config.robots.entries()) {
    if (ids.has(robot.id)) fail(`Duplicate robot id '${robot.id}' in configuration.`);
    ids.add(robot.id);
    const companyKey = normalizeKey(companyForRobot(robot));
    const source = jobSourceFor(robot);
    const existingSource = companySources.get(companyKey);
    if (companyKey && existingSource && existingSource !== source) {
      fail(
        `Company '${companyForRobot(robot)}' is configured with both '${existingSource}' and '${source}' sources.`,
        "Configure exactly one source per company.",
      );
    }
    if (companyKey) companySources.set(companyKey, source);
    if (robot.itemsPath !== undefined) {
      const paths = configuredItemPaths(robot);
      if (
        paths.length === 0 ||
        paths.some((path) => typeof path !== "string" || !path.trim()) ||
        new Set(paths).size !== paths.length
      ) {
        fail(
          `robots[${index}].itemsPath must be a non-empty string or an array of unique non-empty strings.`,
          `Fix ${CONFIG_PATH} and retry.`,
        );
      }
    }
    validateNotificationFilters(robot.notificationFilters, `robots[${index}].notificationFilters`);
  }
  return config;
}

function selectedRobots(config, selector) {
  const robots = config.allRobots || config.robots;
  if (selector === "--all" || selector === undefined) {
    if (robots.length === 0) {
      fail("No company job sources are configured.", `Add a source to ${CONFIG_PATH}, then retry.`);
    }
    return robots;
  }
  const normalized = selector.toLowerCase();
  const robot = robots.find(
    (entry) => entry.id.toLowerCase() === normalized || String(entry.name || "").toLowerCase() === normalized,
  );
  if (!robot) {
    fail(
      `Company source '${selector}' is not configured.`,
      "Run 'mapping-list --all'; for a Maxun robot, run sync-config with its exact ID or name.",
    );
  }
  return [robot];
}

function validateManagedRobotMapping(robot, { requireSafeIdentity = false } = {}) {
  if (!isRecord(robot.fields) || configuredPaths(robot, "title").length === 0) {
    fail("A managed robot mapping must retain at least one title field.");
  }
  const supportedFields = new Set(["title", "url", "location", "date", "id", "company"]);
  for (const [field, configured] of Object.entries(robot.fields)) {
    if (!supportedFields.has(field)) fail(`Managed mapping field '${field}' is not supported.`);
    const paths = typeof configured === "string" ? [configured] : configured;
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((path) => typeof path !== "string" || !path.trim()) ||
      new Set(paths).size !== paths.length
    ) {
      fail(`Managed mapping field '${field}' must be a non-empty string or an array of unique non-empty strings.`);
    }
  }
  if (
    requireSafeIdentity &&
    configuredPaths(robot, "url").length === 0 &&
    configuredPaths(robot, "id").length === 0 &&
    configuredPaths(robot, "location").length === 0
  ) {
    fail(
      "A newly discovered robot mapping must include a URL, job ID, or location field for safe identity.",
      "Inspect the robot result, then retry mapping-set with --url, --job-id, or --location.",
    );
  }
  if (robot.itemsPath !== undefined) {
    const paths = configuredItemPaths(robot);
    if (
      paths.length === 0 ||
      paths.some((path) => typeof path !== "string" || !path.trim()) ||
      new Set(paths).size !== paths.length
    ) {
      fail("Managed itemsPath must be a non-empty string or an array of unique non-empty strings.");
    }
  }
  validateNotificationFilters(robot.notificationFilters, "managed robot notificationFilters");
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
  return value;
}

function parseSince(value) {
  if (value === undefined) return null;
  const duration = String(value).trim().match(/^(\d+)(m|h|d|w)$/i);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount < 1) fail("--since duration must be at least 1 minute.");
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[duration[2].toLowerCase()];
    return new Date(Date.now() - amount * unitMs).toISOString();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail(`Invalid --since value '${value}'.`, "Use a duration such as 7d, 24h, or 2w, or an ISO timestamp.");
  }
  return new Date(timestamp).toISOString();
}

function parseOutputLimit(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    fail("--limit must be an integer from 1 through 500.");
  }
  return parsed;
}

function requireApi() {
  if (!API_KEY) fail("MAXUN_API_KEY is not set.", "Configure the API key and restart the OpenClaw gateway.");
  let parsed;
  try {
    parsed = new URL(BASE_URL);
  } catch {
    fail("MAXUN_BASE_URL is not a valid URL.", "Set it to the Maxun server root URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    fail("MAXUN_BASE_URL must use HTTP or HTTPS.", "Set it to the Maxun server root URL.");
  }
}

async function api(path, options = {}) {
  requireApi();
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs || 30_000),
    });
  } catch (error) {
    const cause = error.cause;
    const causeDetail = cause
      ? [cause.code, cause.message]
          .filter(Boolean)
          .join(": ")
          .replace(/\s+/g, " ")
          .slice(0, 1000)
      : "";
    throw new Error(`Maxun request failed: ${error.message}${causeDetail ? ` (${causeDetail})` : ""}`);
  }
  const text = await response.text();
  const httpStatus = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) {
      const detail = text.trim().replace(/\s+/g, " ").slice(0, 1000) || "empty response body";
      throw new Error(`Maxun returned ${httpStatus}: ${detail}`);
    }
    throw new Error(`Maxun returned HTTP ${response.status} with a non-JSON response: ${text.trim().slice(0, 1000)}`);
  }
  if (!response.ok) {
    const detail = scalar(body.message) || scalar(body.error) || JSON.stringify(body).slice(0, 1000) || "request failed";
    throw new Error(`Maxun returned ${httpStatus}: ${detail}`);
  }
  return body;
}

function robotSourceUrl(robot) {
  const meta = robot.recording_meta || {};
  const direct = [meta.url, meta.sourceUrl, meta.startUrl, robot.url, robot.sourceUrl, robot.startUrl]
    .map((value) => canonicalUrl(scalar(value)))
    .find(validHttpUrl);
  if (direct) return direct;

  const candidates = [];
  const visit = (value, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === "string") {
      const url = canonicalUrl(value);
      if (validHttpUrl(url) && !candidates.includes(url)) candidates.push(url);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (isRecord(value)) Object.values(value).forEach((entry) => visit(entry, depth + 1));
  };
  visit(robot.recording?.workflow || meta.workflow || []);
  let maxunOrigin = "";
  try {
    maxunOrigin = new URL(BASE_URL).origin;
  } catch {
    // BASE_URL is validated before API access; keep all candidates if unavailable.
  }
  return candidates.find((url) => !maxunOrigin || new URL(url).origin !== maxunOrigin) || candidates[0] || "";
}

async function listRobots() {
  const body = await api("/api/sdk/robots");
  const robots = Array.isArray(body.data) ? body.data : [];
  return robots.map((robot) => {
    const meta = robot.recording_meta || {};
    return {
      id: meta.id || robot.id || "",
      name: meta.name || "",
      type: meta.type || "",
      url: robotSourceUrl(robot),
    };
  });
}

async function payloadFor(robot, useLatest) {
  const id = encodeURIComponent(robot.id);
  if (!useLatest) {
    return api(`/api/sdk/robots/${id}/execute`, { method: "POST", body: "{}", timeoutMs: API_TIMEOUT_MS });
  }
  const runs = await api(`/api/sdk/robots/${id}/runs`);
  const completed = (Array.isArray(runs.data) ? runs.data : []).find((run) => run.status === "success");
  if (!completed) throw new Error("no successful Maxun run exists; execute the robot once");
  return { data: completed };
}

function openDatabase() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jobs (
      robot_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      title TEXT NOT NULL COLLATE NOCASE,
      company TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      job_date TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      notification_status TEXT NOT NULL DEFAULT 'unknown',
      filtered_reason TEXT NOT NULL DEFAULT '',
      filter_evaluated_at TEXT NOT NULL DEFAULT '',
      filter_decision_source TEXT NOT NULL DEFAULT '',
      is_current INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (robot_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS jobs_title_idx ON jobs(title);
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      robot_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      new_count INTEGER NOT NULL,
      source_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS robot_configs (
      robot_id TEXT PRIMARY KEY,
      robot_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      configured_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS robot_sources (
      robot_id TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_filter_overrides (
      reason TEXT PRIMARY KEY COLLATE NOCASE,
      action TEXT NOT NULL CHECK (action IN ('upsert', 'remove')),
      pattern TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS robot_filter_exemptions (
      robot_id TEXT NOT NULL COLLATE NOCASE,
      reason TEXT NOT NULL COLLATE NOCASE,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (robot_id, reason)
    );
    CREATE TABLE IF NOT EXISTS robot_mapping_overrides (
      robot_id TEXT PRIMARY KEY COLLATE NOCASE,
      robot_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const jobColumns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  const migrations = [
    ["recorded_at", "ALTER TABLE jobs ADD COLUMN recorded_at TEXT NOT NULL DEFAULT ''"],
    ["notification_status", "ALTER TABLE jobs ADD COLUMN notification_status TEXT NOT NULL DEFAULT 'unknown'"],
    ["filtered_reason", "ALTER TABLE jobs ADD COLUMN filtered_reason TEXT NOT NULL DEFAULT ''"],
    ["filter_evaluated_at", "ALTER TABLE jobs ADD COLUMN filter_evaluated_at TEXT NOT NULL DEFAULT ''"],
    ["filter_decision_source", "ALTER TABLE jobs ADD COLUMN filter_decision_source TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [column, statement] of migrations) {
    if (!jobColumns.has(column)) db.exec(statement);
  }
  db.exec(`
    UPDATE jobs
    SET recorded_at = CASE
      WHEN first_seen_at <> '' THEN first_seen_at
      WHEN last_seen_at <> '' THEN last_seen_at
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    END
    WHERE recorded_at = '';
    CREATE INDEX IF NOT EXISTS jobs_recorded_at_idx ON jobs(recorded_at);
    CREATE INDEX IF NOT EXISTS jobs_notification_status_idx ON jobs(notification_status, recorded_at);
  `);
  return db;
}

function loadAutoConfiguredRobots(db) {
  return db
    .prepare("SELECT config_json FROM robot_configs ORDER BY robot_name COLLATE NOCASE, robot_id")
    .all()
    .flatMap((row) => {
      try {
        const robot = JSON.parse(row.config_json);
        return isRecord(robot) && typeof robot.id === "string" ? [robot] : [];
      } catch {
        return [];
      }
    });
}

function loadManagedRobotMappings(db) {
  return db
    .prepare("SELECT robot_id, robot_name, config_json, updated_at FROM robot_mapping_overrides ORDER BY robot_name COLLATE NOCASE, robot_id")
    .all()
    .flatMap((row) => {
      try {
        const robot = JSON.parse(row.config_json);
        return isRecord(robot) && typeof robot.id === "string" ? [{ ...robot, managedMapping: true, updatedAt: row.updated_at }] : [];
      } catch {
        return [];
      }
    });
}

function saveManagedRobotMapping(db, robot) {
  const updatedAt = new Date().toISOString();
  const stored = { ...robot };
  delete stored.sourceUrl;
  delete stored.managedMapping;
  delete stored.updatedAt;
  db.prepare(`
    INSERT INTO robot_mapping_overrides (robot_id, robot_name, config_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(robot_id) DO UPDATE SET
      robot_name = excluded.robot_name,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(stored.id, stored.name || stored.id, JSON.stringify(stored), updatedAt);
  return updatedAt;
}

function mappingSourceFor(robotId, config, db) {
  if (db.prepare("SELECT 1 FROM robot_mapping_overrides WHERE robot_id = ?").get(robotId)) return "managed";
  if (config.robots.some((robot) => robot.id.toLowerCase() === robotId.toLowerCase())) return "config";
  return "auto-configured";
}

function publicRobotMapping(robot, source) {
  return {
    id: robot.id,
    name: robot.name || robot.id,
    source,
    jobSource: jobSourceFor(robot),
    sourceConfig: robot.source_config,
    itemsPath: robot.itemsPath,
    fields: robot.fields || {},
    static: robot.static || {},
    notificationFilters: robot.notificationFilters,
    updatedAt: robot.updatedAt,
  };
}

function mergedConfig(config, db) {
  const manualIds = new Set(config.robots.map((robot) => robot.id.toLowerCase()));
  const managedRobots = loadManagedRobotMappings(db);
  const managedMappings = new Map(managedRobots.map((robot) => [robot.id.toLowerCase(), robot]));
  const sourceUrls = new Map(
    db.prepare("SELECT robot_id, source_url FROM robot_sources").all().map((row) => [row.robot_id, row.source_url]),
  );
  const filterExemptions = new Map();
  for (const row of loadRobotFilterExemptions(db)) {
    const key = row.robot_id.toLowerCase();
    if (!filterExemptions.has(key)) filterExemptions.set(key, []);
    filterExemptions.get(key).push(row.reason);
  }
  const withSourceUrl = (robot) => {
    const sourceUrl = canonicalUrl(sourceUrls.get(robot.id) || robot.sourceUrl || "");
    const managedExemptions = filterExemptions.get(robot.id.toLowerCase()) || [];
    const configuredExemptions = robot.notificationFilters?.disabledExcludeReasons || [];
    const disabledExcludeReasons = [...new Set([...configuredExemptions, ...managedExemptions].map(normalizeFilterReason))];
    const withFilters = disabledExcludeReasons.length > 0
      ? {
          ...robot,
          notificationFilters: {
            ...(robot.notificationFilters || {}),
            disabledExcludeReasons,
          },
        }
      : robot;
    return sourceUrl ? { ...withFilters, sourceUrl } : withFilters;
  };
  const underlying = [
    ...config.robots,
    ...loadAutoConfiguredRobots(db).filter((robot) => !manualIds.has(robot.id.toLowerCase())),
  ];
  const underlyingIds = new Set(underlying.map((robot) => robot.id.toLowerCase()));
  return {
    ...config,
    allRobots: [
      ...underlying.map((robot) => withSourceUrl(managedMappings.get(robot.id.toLowerCase()) || robot)),
      ...managedRobots.filter((robot) => !underlyingIds.has(robot.id.toLowerCase())).map(withSourceUrl),
    ],
  };
}

function saveRobotSources(db, robots) {
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO robot_sources (robot_id, source_url, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(robot_id) DO UPDATE SET
      source_url = excluded.source_url,
      updated_at = excluded.updated_at
  `);
  for (const robot of robots) {
    const sourceUrl = canonicalUrl(robot.url || robot.sourceUrl || "");
    if (robot.id && validHttpUrl(sourceUrl)) upsert.run(robot.id, sourceUrl, now);
  }
}

function saveAutoConfiguredRobot(db, robot, confidence) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO robot_configs (
      robot_id, robot_name, config_json, confidence, configured_at, last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(robot_id) DO UPDATE SET
      robot_name = excluded.robot_name,
      config_json = excluded.config_json,
      confidence = excluded.confidence,
      last_verified_at = excluded.last_verified_at
  `).run(robot.id, robot.name || robot.id, JSON.stringify(robot), confidence, now, now);
}

function matchingField(keys, aliases) {
  const wanted = new Set(aliases.map(normalizeKey));
  return keys.find((key) => wanted.has(normalizeKey(key)));
}

function fieldSamples(items, key) {
  return items
    .slice(0, 50)
    .map((item) => scalar(item[key]))
    .filter(Boolean);
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeAssetUrl(value) {
  try {
    const parsed = new URL(value);
    return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|css|js|woff2?|ttf|eot)$/iu.test(parsed.pathname);
  } catch {
    return false;
  }
}

function words(value) {
  let decoded = String(value);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed URL escapes are harmless for inference; use the original value.
  }
  return new Set(
    decoded
      .toLowerCase()
      .replace(/https?:\/\//g, " ")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !["www", "com", "jobs", "job", "careers", "career"].includes(word)),
  );
}

function titleUrlOverlap(title, url) {
  const titleWords = words(title);
  const urlWords = words(url);
  if (titleWords.size === 0 || urlWords.size === 0) return 0;
  const matches = [...titleWords].filter((word) => urlWords.has(word)).length;
  return matches / Math.min(4, titleWords.size);
}

function ratioMatching(samples, predicate) {
  return samples.length ? samples.filter(predicate).length / samples.length : 0;
}

const JOB_TITLE_TERMS =
  /\b(?:engineer(?:ing)?|scientist|technician|specialist|manager|director|analyst|associate|operator|supervisor|planner|developer|architect|administrator|coordinator|consultant|intern|trainee|representative|recruiter|counsel|accountant|chemist|mechanic|electrician|quality|maintenance|operations|production|sales|marketing|finance|human resources|supply chain)\b/i;

function looksLikeGeographicLocation(value) {
  const trimmed = value.trim();
  if (/\b(?:united states|usa(?:-[a-z]+)?|multiple locations?|locations? available)\b/i.test(trimmed)) return true;
  if (/^[^,]{2,60},\s*(?:[A-Z]{2}|[A-Z][A-Za-z .'-]{2,30})$/u.test(trimmed)) {
    const prefix = trimmed.split(",", 1)[0];
    return !JOB_TITLE_TERMS.test(prefix);
  }
  return false;
}

function looksLikeWorkplaceMode(value) {
  return /^(?:open to )?(?:remote|hybrid|on[ -]?site)(?:\s*[—-])?$/iu.test(value.trim());
}

function looksLikeLocation(value) {
  return looksLikeGeographicLocation(value) || looksLikeWorkplaceMode(value);
}

function looksLikeUiNoise(value) {
  return /^(?:more details?|details?|share|apply(?: now)?|view (?:job|role)|learn more|regular|full[ -]?time|part[ -]?time|on[ -]?site|hybrid|remote)$/i.test(
    value.trim(),
  );
}

function looksLikeStructuredJobMetadata(value) {
  const segments = value
    .trim()
    .split(/\s*[•|]\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 3) return false;
  return segments.some((segment) =>
    /^(?:full[ -]?time|part[ -]?time|contract|temporary|intern(?:ship)?|on[ -]?site|remote|hybrid)$/iu.test(segment),
  );
}

function looksLikeCompensation(value) {
  return /(?:[$€£¥]\s*\d|\b(?:per (?:hour|year)|hourly|annual|salary|compensation|offers? equity|base pay|base salary)\b)/iu.test(
    value.trim(),
  );
}

function companyNameForRobot(robotMeta) {
  const name = String(robotMeta.name || robotMeta.id)
    .trim()
    .replace(/\s+(?:jobs?|careers?)$/i, "")
    .replace(
      /[-_\s]+(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/i,
      "",
    )
    .trim();
  if (!name) return String(robotMeta.id);
  return name === name.toLowerCase() ? name.replace(/\b[a-z]/g, (letter) => letter.toUpperCase()) : name;
}

function inferCandidate(candidate, robotMeta) {
  const items = candidate.items.slice(0, 50);
  const keys = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const sampleCount = items.length;
  if (sampleCount === 0 || keys.length === 0) return null;

  const stats = new Map(
    keys.map((key) => {
      const samples = fieldSamples(items, key);
      const urlCount = samples.filter(validHttpUrl).length;
      const dateCount = samples.filter((value) =>
        /(?:\b(?:posted|today|yesterday|day|days|hour|hours|week|weeks|month|months)\b|^\d{4}-\d{2}-\d{2})/i.test(value),
      ).length;
      const distinctCount = new Set(samples.map((value) => value.toLowerCase())).size;
      return [
        key,
        {
          samples,
          coverage: samples.length / sampleCount,
          urlRatio: samples.length ? urlCount / samples.length : 0,
          dateRatio: samples.length ? dateCount / samples.length : 0,
          locationRatio: ratioMatching(samples, looksLikeLocation),
          geographicLocationRatio: ratioMatching(samples, looksLikeGeographicLocation),
          workplaceModeRatio: ratioMatching(samples, looksLikeWorkplaceMode),
          jobMetadataRatio: ratioMatching(samples, looksLikeStructuredJobMetadata),
          compensationRatio: ratioMatching(samples, looksLikeCompensation),
          titleTermRatio: ratioMatching(samples, (value) => JOB_TITLE_TERMS.test(value)),
          uiNoiseRatio: ratioMatching(samples, looksLikeUiNoise),
          uniqueRatio: samples.length ? distinctCount / samples.length : 0,
          averageWordCount: samples.length
            ? samples.reduce((sum, value) => sum + value.split(/\s+/).filter(Boolean).length, 0) / samples.length
            : 0,
          averageLength: samples.length
            ? samples.reduce((sum, value) => sum + value.length, 0) / samples.length
            : 0,
        },
      ];
    }),
  );

  const explicitUrl = matchingField(keys, FIELD_ALIASES.url);
  const urlCandidates = keys
    .map((key) => {
      const stat = stats.get(key);
      const jobUrlRatio = stat.samples.filter((value) => /(?:job|career|position|requisition|opening)/i.test(value)).length /
        Math.max(1, stat.samples.length);
      const assetUrlRatio = ratioMatching(stat.samples, looksLikeAssetUrl);
      const keyHint = /(?:url|link|href)/i.test(key);
      const score = stat.urlRatio * 5 + jobUrlRatio * 2 + (key === explicitUrl ? 5 : 0) + (keyHint ? 2 : 0);
      return { key, score, jobUrlRatio, assetUrlRatio, ...stat };
    })
    .filter((entry) => entry.urlRatio >= 0.6 && entry.assetUrlRatio < 0.5)
    .sort((left, right) => right.score - left.score);
  const url = urlCandidates[0] || null;
  if (url && !explicitUrl && !/(?:url|link|href)/i.test(url.key) && url.jobUrlRatio < 0.4) return null;
  if (
    url &&
    !explicitUrl &&
    !/(?:url|link|href)/i.test(url.key) &&
    urlCandidates[1] &&
    url.score - urlCandidates[1].score < 0.5
  ) {
    return null;
  }

  const explicitTitle = matchingField(keys, FIELD_ALIASES.title);
  const titleCandidates = keys
    .filter((key) => key !== url?.key)
    .map((key) => {
      const stat = stats.get(key);
      const paired = url
        ? items
            .map((item) => [scalar(item[key]), scalar(item[url.key])])
            .filter(([title, href]) => title && validHttpUrl(href))
        : [];
      const overlap = paired.length
        ? paired.reduce((sum, [title, href]) => sum + titleUrlOverlap(title, href), 0) / paired.length
        : 0;
      const keyHint = /(?:title|position|role|job.?name)/i.test(key);
      const labelNoise = stat.samples.filter((value) => /^(?:location|locations|job type|posted on|apply)$/i.test(value)).length /
        Math.max(1, stat.samples.length);
      const score =
        stat.coverage * 2 +
        stat.uniqueRatio * 5 +
        Math.min(2, stat.averageWordCount / 2) +
        stat.titleTermRatio * 2 +
        overlap * 7 +
        (key === explicitTitle ? 8 : 0) +
        (keyHint ? 4 : 0) -
        stat.urlRatio * 10 -
        stat.dateRatio * 8 -
        stat.geographicLocationRatio * 6 -
        stat.workplaceModeRatio * 4 -
        stat.jobMetadataRatio * 8 -
        stat.compensationRatio * 8 -
        stat.uiNoiseRatio * 8 -
        labelNoise * 6 -
        (stat.averageLength > 180 ? 5 : 0);
      return { key, score, overlap, ...stat };
    })
    .filter((entry) => entry.coverage >= 0.6 && entry.averageLength >= 3 && entry.averageLength <= 180)
    .sort((left, right) => right.score - left.score);
  const title = titleCandidates[0];
  const runnerUpTitle = titleCandidates[1];
  const genericTitleIsStrong =
    title &&
    title.uniqueRatio >= 0.6 &&
    title.uiNoiseRatio <= 0.2 &&
    title.locationRatio < 0.5 &&
    title.dateRatio < 0.2 &&
    title.score >= 7 &&
    (!runnerUpTitle || title.score - runnerUpTitle.score >= 2);
  if (!title || (title.key !== explicitTitle && title.overlap < 0.35 && !genericTitleIsStrong)) return null;

  const field = (name) => matchingField(keys, FIELD_ALIASES[name]);
  let id = field("id");
  if (!id && url) {
    id = keys.find((key) => {
      if (key === title.key || key === url.key) return false;
      const samples = stats.get(key).samples;
      if (samples.length < sampleCount * 0.6 || samples.some((value) => value.length > 80)) return false;
      const paired = items.map((item) => [scalar(item[key]), scalar(item[url.key])]).filter(([value, href]) => value && href);
      return paired.length > 0 && paired.filter(([value, href]) => href.toLowerCase().includes(value.toLowerCase())).length / paired.length >= 0.6;
    });
  }
  let date = field("date");
  if (!date) {
    date = keys
      .filter((key) => key !== title.key && key !== url?.key)
      .sort((left, right) => stats.get(right).dateRatio - stats.get(left).dateRatio)
      .find((key) => stats.get(key).dateRatio >= 0.6);
  }
  let location = field("location");
  if (!location) {
    location = keys
      .filter((key) => ![title.key, url?.key, id, date].includes(key))
      .map((key) => ({ key, ...stats.get(key) }))
      .filter(
        (entry) =>
          entry.coverage >= 0.6 &&
          entry.averageLength <= 180 &&
          (entry.locationRatio >= 0.5 || entry.jobMetadataRatio >= 0.6),
      )
      .sort(
        (left, right) =>
          right.geographicLocationRatio * 6 +
            right.locationRatio * 2 +
            right.jobMetadataRatio * 3 +
            right.uniqueRatio -
            right.workplaceModeRatio * 4 -
          (left.geographicLocationRatio * 6 +
            left.locationRatio * 2 +
            left.jobMetadataRatio * 3 +
            left.uniqueRatio -
            left.workplaceModeRatio * 4),
      )[0]?.key;
  }

  // Without a durable URL or ID, require a strong, separate location field so
  // semantic identity remains title + company + location instead of title alone.
  if (!url && !id) {
    const locationStat = location ? stats.get(location) : null;
    if (
      !genericTitleIsStrong ||
      !locationStat ||
      (locationStat.locationRatio < 0.5 && locationStat.jobMetadataRatio < 0.6)
    ) {
      return null;
    }
  }

  const fields = { title: title.key };
  if (url) fields.url = url.key;
  if (location) fields.location = location;
  if (date) fields.date = date;
  if (id) fields.id = id;
  const confidence = Math.min(
    0.99,
    Number(
      (
        (url || id ? 0.82 : 0.8) +
        Math.min(0.1, title.overlap * 0.15) +
        (title.key === explicitTitle ? 0.05 : 0) +
        (genericTitleIsStrong ? 0.05 : 0)
      ).toFixed(2),
    ),
  );
  const displayName = String(robotMeta.name || robotMeta.id).trim();
  return {
    confidence,
    robot: {
      id: robotMeta.id,
      name: displayName,
      itemsPath: candidate.path,
      fields,
      static: { company: companyNameForRobot(robotMeta) },
      autoConfigured: true,
    },
  };
}

function inferRobotConfig(robotMeta, payload) {
  const suggestions = arraysOfRecords(payload)
    .filter((candidate) => candidate.items.length > 0)
    .map((candidate) => inferCandidate(candidate, robotMeta))
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence || right.robot.itemsPath.length - left.robot.itemsPath.length);
  return suggestions[0] || null;
}

async function synchronizeRobotConfigs(config, selector, useLatest, payloadPath) {
  const db = openDatabase();
  const current = mergedConfig(config, db);
  const knownIds = new Set(current.allRobots.map((robot) => robot.id.toLowerCase()));
  const nonMaxunCompanies = new Set(
    config.robots
      .filter((robot) => jobSourceFor(robot) !== "maxun")
      .map((robot) => normalizeKey(companyForRobot(robot)))
      .filter(Boolean),
  );
  let liveRobots;
  if (payloadPath) {
    if (!selector || selector === "--all") {
      db.close();
      throw new Error("sync-config with --payload-file requires one robot ID");
    }
    liveRobots = [{ id: selector, name: selector }];
  } else {
    liveRobots = await listRobots();
    saveRobotSources(db, liveRobots);
    liveRobots = liveRobots.filter(
      (robot) => !nonMaxunCompanies.has(normalizeKey(companyNameForRobot(robot))),
    );
  }
  if (selector && selector !== "--all") {
    const normalized = selector.toLowerCase();
    liveRobots = liveRobots.filter(
      (robot) => robot.id.toLowerCase() === normalized || String(robot.name || "").toLowerCase() === normalized,
    );
    if (liveRobots.length === 0) {
      db.close();
      throw new Error(`Maxun robot '${selector}' was not found`);
    }
  }

  const configured = [];
  const needsReview = [];
  for (const robotMeta of liveRobots.filter((robot) => robot.id && !knownIds.has(robot.id.toLowerCase()))) {
    try {
      const payload = payloadPath ? parseJsonFile(payloadPath, "fixture payload") : await payloadFor(robotMeta, useLatest);
      const inferred = inferRobotConfig(robotMeta, payload);
      if (!inferred) {
        needsReview.push({
          robotId: robotMeta.id,
          robotName: robotMeta.name || robotMeta.id,
          reason: "No high-confidence job mapping was found.",
          nextAction: `Run 'inspect ${robotMeta.id} --latest', then save the confirmed fields with 'mapping-set ${robotMeta.id} ...'.`,
        });
        continue;
      }
      const selected = selectItems(payload, inferred.robot);
      const normalized = normalizeJobs(selected.items, inferred.robot);
      if (selected.items.length > 0 && normalized.jobs.length === 0) {
        throw new Error(`found ${selected.items.length} items at '${selected.path}', but none had a job title`);
      }
      const stored = storeJobs(db, inferred.robot, normalized, "baseline", selected.path);
      const baselineDecisions = filterNewJobs(normalized.jobs, config, inferred.robot);
      if (normalized.jobs.length > 0) {
        recordNotificationDecisions(db, inferred.robot.id, baselineDecisions, stored.now, "baseline");
      }
      saveAutoConfiguredRobot(db, inferred.robot, inferred.confidence);
      knownIds.add(robotMeta.id.toLowerCase());
      configured.push({
        ...inferred.robot,
        confidence: inferred.confidence,
        identityMode: inferred.robot.fields.url || inferred.robot.fields.id ? "durable-id" : "title+company+location",
        baselineCount: normalized.jobs.length,
        skippedWithoutTitle: normalized.skipped.length,
      });
    } catch (error) {
      needsReview.push({
        robotId: robotMeta.id,
        robotName: robotMeta.name || robotMeta.id,
        reason: error.message,
        nextAction: `Run this robot successfully in Maxun, then run 'sync-config ${robotMeta.id}'.`,
      });
    }
  }
  const result = {
    checked: liveRobots.length,
    configured,
    needsReview,
  };
  const updated = mergedConfig(config, db);
  db.close();
  return { result, config: updated };
}

function storeJobs(db, robot, normalized, mode, sourcePath) {
  const now = new Date().toISOString();
  const exists = db.prepare("SELECT 1 FROM jobs WHERE robot_id = ? AND item_key = ?");
  const upsert = db.prepare(`
    INSERT INTO jobs (
      robot_id, item_key, title, company, location, job_date, url, raw_json,
      recorded_at, first_seen_at, last_seen_at, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(robot_id, item_key) DO UPDATE SET
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      job_date = excluded.job_date,
      url = excluded.url,
      raw_json = excluded.raw_json,
      last_seen_at = excluded.last_seen_at,
      is_current = 1
  `);
  const markMissing = db.prepare("UPDATE jobs SET is_current = 0 WHERE robot_id = ?");
  const rekeyLegacy = db.prepare(`
    UPDATE jobs SET
      item_key = ?,
      title = ?,
      company = ?,
      location = ?,
      job_date = ?,
      url = ?,
      raw_json = ?,
      last_seen_at = ?,
      is_current = 1
    WHERE robot_id = ? AND item_key = ?
  `);
  const insertScan = db.prepare(
    "INSERT INTO scans (robot_id, mode, scanned_at, item_count, new_count, source_path) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const newJobs = [];
  let identityUpgradeCount = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const legacyBySemantic = new Map();
    for (const row of db
      .prepare(
        "SELECT item_key, title, company, location FROM jobs WHERE robot_id = ? AND is_current = 1 AND url = ''",
      )
      .all(robot.id)) {
      const key = semanticIdentity(row);
      const matches = legacyBySemantic.get(key) || [];
      matches.push(row.item_key);
      legacyBySemantic.set(key, matches);
    }
    markMissing.run(robot.id);
    for (const job of normalized.jobs) {
      let isNew = !exists.get(robot.id, job.itemKey);
      const legacyMatches = legacyBySemantic.get(semanticIdentity(job)) || [];
      if (isNew && (job.url || job.id) && legacyMatches.length === 1) {
        rekeyLegacy.run(
          job.itemKey,
          job.title,
          job.company,
          job.location,
          job.date,
          job.url,
          JSON.stringify(job.raw),
          now,
          robot.id,
          legacyMatches[0],
        );
        legacyBySemantic.delete(semanticIdentity(job));
        identityUpgradeCount += 1;
        isNew = false;
      } else {
        upsert.run(
          robot.id,
          job.itemKey,
          job.title,
          job.company,
          job.location,
          job.date,
          job.url,
          JSON.stringify(job.raw),
          now,
          now,
          now,
        );
      }
      if (isNew) newJobs.push(job);
    }
    insertScan.run(robot.id, mode, now, normalized.jobs.length, mode === "baseline" ? 0 : newJobs.length, sourcePath);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { now, newJobs, identityUpgradeCount };
}

function publicJob(job, robot) {
  const sourceUrl = canonicalUrl(robot.sourceUrl || "");
  const fallbackUrl = !job.url && validHttpUrl(sourceUrl) ? sourceUrl : "";
  return {
    title: job.title,
    company: job.company || robot.static?.company || robot.name || robot.id,
    location: job.location,
    date: job.date,
    url: job.url || fallbackUrl,
    urlIsFallback: Boolean(fallbackUrl),
    robotId: robot.id,
    robotName: robot.name || robot.id,
  };
}

function groupPositionTitles(jobs, outputLimit) {
  const byCompany = new Map();
  for (const job of jobs) {
    const company = job.company || job.robotName || job.robotId;
    if (!byCompany.has(company)) byCompany.set(company, new Map());
    const positions = byCompany.get(company);
    const existing = positions.get(job.title);
    if (!existing || (!job.urlIsFallback && existing.urlIsFallback) || (!existing.url && job.url)) {
      positions.set(job.title, {
        title: job.title,
        url: job.url || "",
        urlIsFallback: Boolean(job.urlIsFallback),
      });
    }
  }
  const allGroups = [...byCompany.entries()]
    .map(([company, positions]) => ({
      company,
      positions: [...positions.values()].sort((left, right) => left.title.localeCompare(right.title)),
    }))
    .sort((left, right) => left.company.localeCompare(right.company));
  const positionCount = allGroups.reduce((sum, group) => sum + group.positions.length, 0);
  let remaining = outputLimit;
  const groups = [];
  for (const group of allGroups) {
    if (remaining <= 0) break;
    const positions = group.positions.slice(0, remaining);
    if (positions.length > 0) groups.push({ company: group.company, positions });
    remaining -= positions.length;
  }
  const returnedPositionCount = groups.reduce((sum, group) => sum + group.positions.length, 0);
  return {
    groups,
    positionCount,
    returnedPositionCount,
    omittedPositionCount: Math.max(0, positionCount - returnedPositionCount),
  };
}

function storedJobForFiltering(row) {
  return {
    itemKey: row.item_key,
    title: row.title,
    company: row.company,
    location: row.location,
    date: row.job_date,
    url: row.url,
  };
}

function backfillUnknownNotificationDecisions(db, config, robots) {
  let backfilledDecisionCount = 0;
  const evaluatedAt = new Date().toISOString();
  for (const robot of robots) {
    const jobs = db
      .prepare(`
        SELECT item_key, title, company, location, job_date, url
        FROM jobs
        WHERE robot_id = ? AND notification_status = 'unknown'
      `)
      .all(robot.id)
      .map(storedJobForFiltering);
    if (jobs.length === 0) continue;
    const filtered = filterNewJobs(jobs, config, robot);
    recordNotificationDecisions(db, robot.id, filtered, evaluatedAt, "backfill");
    backfilledDecisionCount += jobs.length;
  }
  return backfilledDecisionCount;
}

function publicStoredJob(row, robot) {
  return {
    ...publicJob(
      {
        title: row.title,
        company: row.company,
        location: row.location,
        date: row.job_date,
        url: row.url,
      },
      robot,
    ),
    recordedAt: row.recorded_at,
    filteredReason: row.filtered_reason,
    filterEvaluatedAt: row.filter_evaluated_at,
    filterDecisionSource: row.filter_decision_source,
    isCurrent: Boolean(row.is_current),
  };
}

function filteredJobHistory(db, config, robots, since, outputLimit) {
  const backfilledDecisionCount = backfillUnknownNotificationDecisions(db, config, robots);
  const robotById = new Map(robots.map((robot) => [robot.id, robot]));
  const placeholders = robots.map(() => "?").join(", ");
  const sinceClause = since ? "AND recorded_at >= ?" : "";
  const parameters = [...robots.map((robot) => robot.id), ...(since ? [since] : [])];
  const rows = db
    .prepare(`
      SELECT
        robot_id, title, company, location, job_date, url, recorded_at,
        notification_status, filtered_reason, filter_evaluated_at,
        filter_decision_source, is_current
      FROM jobs
      WHERE notification_status = 'filtered'
        AND robot_id IN (${placeholders})
        ${sinceClause}
      ORDER BY recorded_at DESC, company COLLATE NOCASE, title COLLATE NOCASE
    `)
    .all(...parameters);
  const filteredJobs = rows.map((row) => publicStoredJob(row, robotById.get(row.robot_id) || { id: row.robot_id }));
  const limited = filteredJobs.slice(0, outputLimit);
  const grouped = groupPositionTitles(filteredJobs, outputLimit);
  const filteredOutByReason = {};
  const decisionSources = {};
  for (const job of filteredJobs) {
    filteredOutByReason[job.filteredReason] = (filteredOutByReason[job.filteredReason] || 0) + 1;
    decisionSources[job.filterDecisionSource] = (decisionSources[job.filterDecisionSource] || 0) + 1;
  }
  const unknownDecisionCount = db
    .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE notification_status = 'unknown' AND robot_id IN (${placeholders})`)
    .get(...robots.map((robot) => robot.id)).count;
  return {
    status: "ok",
    databasePath: DB_PATH,
    timeField: "recorded_at",
    since,
    filteredCount: filteredJobs.length,
    returnedCount: limited.length,
    omittedFilteredCount: Math.max(0, filteredJobs.length - limited.length),
    filteredOutByReason,
    decisionSources,
    backfilledDecisionCount,
    unknownDecisionCount,
    filteredJobs: limited,
    filteredPositionCount: grouped.positionCount,
    returnedPositionCount: grouped.returnedPositionCount,
    omittedFilteredPositionCount: grouped.omittedPositionCount,
    filteredJobsByCompany: grouped.groups,
  };
}

function previewNotificationFilters(db, config, robots) {
  const results = [];
  const filteredOutByReason = {};
  const filteredExamples = [];
  for (const robot of robots) {
    const jobs = db
      .prepare(
        "SELECT title, company, location, job_date AS date, url FROM jobs WHERE robot_id = ? AND is_current = 1 ORDER BY title COLLATE NOCASE",
      )
      .all(robot.id);
    const filtered = filterNewJobs(jobs, config, robot);
    for (const [reason, count] of Object.entries(filtered.filteredOutByReason)) {
      filteredOutByReason[reason] = (filteredOutByReason[reason] || 0) + count;
    }
    for (const { job, reason } of filtered.filteredOut) {
      if (filteredExamples.length >= 50) break;
      filteredExamples.push({
        title: job.title,
        company: job.company || robot.static?.company || "",
        location: job.location,
        reason,
        robotId: robot.id,
        robotName: robot.name || robot.id,
      });
    }
    results.push({
      robotId: robot.id,
      robotName: robot.name || robot.id,
      currentCount: jobs.length,
      wouldPassCount: filtered.accepted.length,
      filteredOutCount: filtered.filteredOutCount,
      filteredOutByReason: filtered.filteredOutByReason,
    });
  }
  return {
    status: "ok",
    currentCount: results.reduce((sum, result) => sum + result.currentCount, 0),
    wouldPassCount: results.reduce((sum, result) => sum + result.wouldPassCount, 0),
    filteredOutCount: results.reduce((sum, result) => sum + result.filteredOutCount, 0),
    filteredOutByReason,
    filteredExamples,
    robots: results,
  };
}

async function inspectRobot(robot, useLatest, payloadPath) {
  const payload = payloadPath ? parseJsonFile(payloadPath, "fixture payload") : await payloadFor(robot, useLatest);
  const candidates = arraysOfRecords(payload)
    .map((candidate) => ({
      path: candidate.path,
      itemCount: candidate.items.length,
      fields: [...new Set(candidate.items.slice(0, 10).flatMap((item) => Object.keys(item)))].sort(),
      detectedTitles: candidate.items.slice(0, 10).map((item) => fieldValue(item, robot, "title")).filter(Boolean).slice(0, 3),
    }))
    .filter((candidate) => candidate.itemCount > 0)
    .sort((left, right) => right.detectedTitles.length - left.detectedTitles.length || right.itemCount - left.itemCount)
    .slice(0, 20);
  const inferred = inferRobotConfig(robot, payload);
  return {
    robotId: robot.id,
    robotName: robot.name || robot.id,
    candidates,
    suggestedConfig: inferred ? { ...inferred.robot, confidence: inferred.confidence } : null,
  };
}

async function retrieveItems(robot, useLatest, payloadPath) {
  const source = jobSourceFor(robot);
  if (source === "maxun") {
    const payload = payloadPath ? parseJsonFile(payloadPath, "fixture payload") : await payloadFor(robot, useLatest);
    return selectItems(payload, robot);
  }
  if (payloadPath) {
    throw new Error(`--payload-file is only supported for Maxun sources, not ${source}`);
  }
  if (source === "smartrecruiters") {
    const items = await getSmartRecruitersJobs(
      { company: companyForRobot(robot), source_config: robot.source_config },
      { log: (message) => process.stderr.write(`${message}\n`) },
    );
    return { path: "smartrecruiters-public-api", items };
  }
  if (source === "greenhouse") {
    const items = await getGreenhouseJobs(
      { company: companyForRobot(robot), source_config: robot.source_config },
      { log: (message) => process.stderr.write(`${message}\n`) },
    );
    return { path: "greenhouse-job-board-api", items };
  }
  throw new Error(`Unsupported job source: ${source}`);
}

async function runMonitor(mode, robots, useLatest, payloadPath, outputLimit, autoConfiguration, config) {
  const db = openDatabase();
  const results = [];
  const errors = [];
  const newlyBaselined = new Map(autoConfiguration.configured.map((robot) => [robot.id, robot]));
  for (const robot of robots) {
    const discovery = newlyBaselined.get(robot.id);
    if (discovery) {
      results.push({
        robotId: robot.id,
        robotName: robot.name || robot.id,
        jobSource: jobSourceFor(robot),
        sourcePath: discovery.itemsPath,
        itemCount: discovery.baselineCount,
        newCount: 0,
        discoveredNewCount: 0,
        identityUpgradeCount: 0,
        filteredOutCount: 0,
        filteredOutByReason: {},
        baselineCount: discovery.baselineCount,
        skippedWithoutTitle: discovery.skippedWithoutTitle,
        autoBaselined: true,
        newJobs: [],
      });
      continue;
    }
    try {
      const selected = await retrieveItems(robot, useLatest, payloadPath);
      const normalized = normalizeJobs(selected.items, robot);
      if (selected.items.length > 0 && normalized.jobs.length === 0) {
        throw new Error(`found ${selected.items.length} items at '${selected.path}', but none had a job title`);
      }
      const stored = storeJobs(db, robot, normalized, mode, selected.path);
      const discoveredNewJobs = mode === "baseline" ? [] : stored.newJobs;
      const decisionJobs = mode === "baseline" ? normalized.jobs : discoveredNewJobs;
      const decisions = filterNewJobs(decisionJobs, config, robot);
      if (decisionJobs.length > 0) {
        recordNotificationDecisions(db, robot.id, decisions, stored.now, mode === "baseline" ? "baseline" : "discovery");
      }
      const filtered = mode === "baseline"
        ? { accepted: [], filteredOut: [], filteredOutCount: 0, filteredOutByReason: {} }
        : decisions;
      results.push({
        robotId: robot.id,
        robotName: robot.name || robot.id,
        jobSource: jobSourceFor(robot),
        sourcePath: selected.path,
        itemCount: normalized.jobs.length,
        newCount: filtered.accepted.length,
        discoveredNewCount: discoveredNewJobs.length,
        identityUpgradeCount: stored.identityUpgradeCount,
        filteredOutCount: filtered.filteredOutCount,
        filteredOutByReason: filtered.filteredOutByReason,
        baselineCount: mode === "baseline" ? normalized.jobs.length : undefined,
        duplicateCount: normalized.duplicateCount,
        skippedWithoutTitle: normalized.skipped.length,
        newJobs: filtered.accepted.map((job) => publicJob(job, robot)),
      });
    } catch (error) {
      const source = jobSourceFor(robot);
      if (source !== "maxun") process.stderr.write(`[${companyForRobot(robot)}] ${error.message}\n`);
      errors.push({
        robotId: robot.id,
        robotName: robot.name || robot.id,
        jobSource: source,
        error: error.message,
        nextAction:
          source === "maxun"
            ? `Run 'inspect ${robot.id} --latest' or verify Maxun connectivity and configuration.`
            : `Verify the ${source} source configuration and API connectivity, then retry.`,
      });
    }
  }
  db.close();
  const allNew = results.flatMap((result) => result.newJobs);
  allNew.sort((left, right) => left.title.localeCompare(right.title) || left.location.localeCompare(right.location));
  const limited = allNew.slice(0, outputLimit);
  const groupedPositions = groupPositionTitles(allNew, outputLimit);
  const filteredOutByReason = {};
  for (const result of results) {
    for (const [reason, count] of Object.entries(result.filteredOutByReason || {})) {
      filteredOutByReason[reason] = (filteredOutByReason[reason] || 0) + count;
    }
  }
  const jobSources = [...new Set(robots.map(jobSourceFor))];
  const retrievalSource =
    jobSources.length === 1 && jobSources[0] === "maxun"
      ? payloadPath
        ? "fixture"
        : useLatest
          ? "latest-successful-run"
          : "new-robot-run"
      : jobSources.length === 1
        ? `${jobSources[0]}-api`
        : "configured-sources";
  return {
    status:
      errors.length === 0 && autoConfiguration.needsReview.length === 0
        ? "ok"
        : results.length > 0
          ? "partial"
          : "error",
    mode,
    source: retrievalSource,
    jobSources,
    checkedAt: new Date().toISOString(),
    robotCount: robots.length,
    itemCount: results.reduce((sum, result) => sum + result.itemCount, 0),
    newCount: mode === "baseline" ? 0 : allNew.length,
    discoveredNewCount: results.reduce((sum, result) => sum + (result.discoveredNewCount || 0), 0),
    identityUpgradeCount: results.reduce((sum, result) => sum + (result.identityUpgradeCount || 0), 0),
    filteredOutCount: results.reduce((sum, result) => sum + (result.filteredOutCount || 0), 0),
    filteredOutByReason,
    baselineCount: mode === "baseline" ? results.reduce((sum, result) => sum + result.itemCount, 0) : undefined,
    returnedCount: limited.length,
    omittedNewCount: Math.max(0, allNew.length - limited.length),
    newJobs: limited,
    newPositionCount: groupedPositions.positionCount,
    returnedPositionCount: groupedPositions.returnedPositionCount,
    omittedNewPositionCount: groupedPositions.omittedPositionCount,
    newJobsByCompany: groupedPositions.groups,
    robots: results.map(({ newJobs: _newJobs, ...result }) => result),
    autoConfiguration,
    errors,
  };
}

function printUsage() {
  process.stdout.write(`Job source monitor\n\nCommands:\n  robots\n  sync-config [<robot>|--all]\n  inspect <robot> [--latest|--run]\n  mapping-list [<robot>|--all]\n  mapping-set <robot> [--title <field>] [--url <field>] [--location <field>] [--date <field>] [--job-id <field>] [--items-path <path>] [--company <name>]\n  mapping-remove <robot>\n  baseline [<company>|--all] [--latest|--run]\n  scan [<company>|--all] [--latest]\n  filter-list [<company>|--all]\n  filter-add <keyword> [--reason <reason>] [--pattern <regex>]\n  filter-remove <reason>\n  filter-exempt <company> <reason> [<reason>...]\n  filter-restore <company> <reason> [<reason>...]\n  filter-preview [<company>|--all]\n  filtered-jobs [<company>|--all] [--since <7d|24h|2w|ISO>] [--limit <1-500>]\n  status\n  config-check\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }
  const baseConfig = loadConfig();
  let config = baseConfig;
  let managedOverrideCount = 0;
  let managedMappingOverrideCount = 0;
  let managedCompanyFilterExemptionCount = 0;
  if (existsSync(DB_PATH)) {
    const db = openDatabase();
    managedOverrideCount = loadManagedFilterOverrides(db).length;
    managedMappingOverrideCount = loadManagedRobotMappings(db).length;
    managedCompanyFilterExemptionCount = loadRobotFilterExemptions(db).length;
    config = configWithManagedFilterOverrides(baseConfig, db);
    db.close();
  }

  if (command === "config-check") {
    let autoConfiguredCount = 0;
    if (existsSync(DB_PATH)) {
      const db = openDatabase();
      autoConfiguredCount = loadAutoConfiguredRobots(db).length;
      db.close();
    }
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        configPath: CONFIG_PATH,
        databasePath: DB_PATH,
        manualRobotCount: config.robots.length,
        sourceCounts: Object.fromEntries(
          [...SUPPORTED_JOB_SOURCES].map((source) => [
            source,
            config.robots.filter((robot) => jobSourceFor(robot) === source).length,
          ]),
        ),
        autoConfiguredCount,
        managedMappingOverrideCount,
        autoConfigure: config.autoConfigure === true,
        notificationFilters: {
          excludeTitlePatternCount: config.notificationFilters?.excludeTitlePatterns?.length || 0,
          includeTitlePatternCount: config.notificationFilters?.includeTitlePatterns?.length || 0,
          robotOverrideCount: config.robots.filter((robot) => robot.notificationFilters !== undefined).length,
          managedOverrideCount,
          managedCompanyFilterExemptionCount,
        },
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "mapping-list") {
    const selector = args[0] || "--all";
    const db = openDatabase();
    const available = mergedConfig(config, db);
    const robots = selectedRobots(available, selector);
    const mappings = robots.map((robot) => publicRobotMapping(robot, mappingSourceFor(robot.id, config, db)));
    db.close();
    process.stdout.write(`${JSON.stringify({ status: "ok", databasePath: DB_PATH, mappings }, null, 2)}\n`);
    return;
  }
  if (command === "mapping-set") {
    const selector = args[0];
    if (!selector || selector.startsWith("--")) fail("mapping-set requires one robot ID or exact Maxun name.");
    const db = openDatabase();
    const available = mergedConfig(config, db);
    const normalizedSelector = selector.toLowerCase();
    let current = (available.allRobots || available.robots).find(
      (robot) =>
        robot.id.toLowerCase() === normalizedSelector || String(robot.name || "").toLowerCase() === normalizedSelector,
    );
    let newlyDiscovered = false;
    if (!current) {
      let liveRobots;
      try {
        liveRobots = await listRobots();
      } catch (error) {
        db.close();
        fail(error.message, "Verify Maxun connectivity, then retry mapping-set.");
      }
      const matches = liveRobots.filter(
        (robot) =>
          robot.id.toLowerCase() === normalizedSelector || String(robot.name || "").toLowerCase() === normalizedSelector,
      );
      if (matches.length === 0) {
        db.close();
        fail(`Maxun robot '${selector}' was not found.`, "Run 'robots' and retry with an exact ID or name.");
      }
      if (matches.length > 1 && !matches.some((robot) => robot.id.toLowerCase() === normalizedSelector)) {
        db.close();
        fail(`More than one Maxun robot is named '${selector}'.`, "Retry mapping-set with the robot ID.");
      }
      const liveRobot = matches.find((robot) => robot.id.toLowerCase() === normalizedSelector) || matches[0];
      saveRobotSources(db, [liveRobot]);
      current = {
        id: liveRobot.id,
        name: liveRobot.name || liveRobot.id,
        fields: {},
        static: { company: companyNameForRobot(liveRobot) },
      };
      newlyDiscovered = true;
    }
    if (jobSourceFor(current) !== "maxun") {
      db.close();
      fail(
        `mapping-set applies only to Maxun robots; '${selector}' uses ${jobSourceFor(current)}.`,
        "Edit that company's source_config and run config-check.",
      );
    }
    const candidate = JSON.parse(JSON.stringify(current));
    delete candidate.sourceUrl;
    delete candidate.managedMapping;
    delete candidate.updatedAt;
    candidate.fields = { ...(candidate.fields || {}) };
    candidate.static = { ...(candidate.static || {}) };
    const fieldFlags = [
      ["--title", "title"],
      ["--url", "url"],
      ["--location", "location"],
      ["--date", "date"],
      ["--job-id", "id"],
    ];
    let changeCount = 0;
    for (const [flag, field] of fieldFlags) {
      const value = optionValue(args, flag);
      if (value !== undefined) {
        candidate.fields[field] = value;
        changeCount += 1;
      }
      if (args.includes(`--clear-${field === "id" ? "job-id" : field}`)) {
        delete candidate.fields[field];
        changeCount += 1;
      }
    }
    const itemsPath = optionValue(args, "--items-path");
    if (itemsPath !== undefined) {
      candidate.itemsPath = itemsPath;
      changeCount += 1;
    }
    const company = optionValue(args, "--company");
    if (company !== undefined) {
      candidate.static.company = company;
      changeCount += 1;
    }
    if (changeCount === 0) {
      db.close();
      fail("mapping-set requires at least one field, items-path, company, or clear option.");
    }
    validateManagedRobotMapping(candidate, { requireSafeIdentity: newlyDiscovered });
    const updatedAt = saveManagedRobotMapping(db, candidate);
    const effective = mergedConfig(config, db);
    const saved = selectedRobots(effective, candidate.id)[0];
    const mapping = publicRobotMapping(saved, "managed");
    db.close();
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        action: "saved",
        newlyDiscovered,
        databasePath: DB_PATH,
        updatedAt,
        mapping,
        nextAction: newlyDiscovered
          ? `Run 'baseline ${candidate.id} --latest' after a successful stored Maxun run, or use '--run' to execute and baseline it.`
          : undefined,
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "mapping-remove") {
    const selector = args[0];
    if (!selector || selector.startsWith("--")) fail("mapping-remove requires one configured robot ID or exact name.");
    const db = openDatabase();
    const available = mergedConfig(config, db);
    const current = selectedRobots(available, selector)[0];
    const removed = db.prepare("DELETE FROM robot_mapping_overrides WHERE robot_id = ?").run(current.id);
    if (Number(removed.changes) === 0) {
      db.close();
      fail(`Robot '${selector}' has no managed mapping override.`, "Run 'mapping-list' to inspect mapping sources.");
    }
    const restoredAvailable = mergedConfig(config, db);
    const restored = (restoredAvailable.allRobots || restoredAvailable.robots).find(
      (robot) => robot.id.toLowerCase() === current.id.toLowerCase(),
    );
    const mapping = restored ? publicRobotMapping(restored, mappingSourceFor(restored.id, config, db)) : null;
    db.close();
    process.stdout.write(
      `${JSON.stringify({ status: "ok", action: "removed", databasePath: DB_PATH, restored: Boolean(mapping), mapping }, null, 2)}\n`,
    );
    return;
  }
  if (command === "filter-list") {
    const db = openDatabase();
    const effectiveConfig = configWithManagedFilterOverrides(baseConfig, db);
    const summary = managedFilterSummary(baseConfig, effectiveConfig, db);
    const available = mergedConfig(effectiveConfig, db);
    const selector = args[0];
    const companyRobots = selector
      ? selectedRobots(available, selector)
      : available.allRobots.filter(
          (robot) => effectiveNotificationFilters(effectiveConfig, robot).disabledExcludeReasons.length > 0,
        );
    const companyOverrides = companyRobots.map((robot) => publicCompanyFilterOverride(effectiveConfig, robot));
    db.close();
    process.stdout.write(
      `${JSON.stringify({ status: "ok", databasePath: DB_PATH, caseInsensitive: true, ...summary, companyOverrides }, null, 2)}\n`,
    );
    return;
  }
  if (command === "filter-exempt") {
    const selector = args[0];
    const requestedReasons = args.slice(1);
    if (!selector || selector.startsWith("--") || requestedReasons.length === 0) {
      fail("filter-exempt requires one configured robot and at least one deny keyword or reason.");
    }
    const db = openDatabase();
    const available = mergedConfig(config, db);
    const robot = selectedRobots(available, selector)[0];
    const rules = new Map();
    for (const requested of requestedReasons) {
      const rule = resolveRequestedFilterReason(config, robot, requested);
      rules.set(normalizeFilterReason(rule.reason), rule);
    }
    let updatedAt = "";
    for (const [reason] of rules) updatedAt = setRobotFilterExemption(db, robot.id, reason);
    const updatedRobot = selectedRobots(mergedConfig(config, db), robot.id)[0];
    const companyOverride = publicCompanyFilterOverride(config, updatedRobot);
    const managedExemptions = loadRobotFilterExemptions(db, robot.id).map((row) => row.reason);
    db.close();
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        action: "exempted",
        databasePath: DB_PATH,
        updatedAt,
        exemptedRules: [...rules.values()],
        managedExemptions,
        companyOverride,
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "filter-restore") {
    const selector = args[0];
    const requestedReasons = args.slice(1);
    if (!selector || selector.startsWith("--") || requestedReasons.length === 0) {
      fail("filter-restore requires one configured robot and at least one deny keyword or reason.");
    }
    const db = openDatabase();
    const available = mergedConfig(config, db);
    const robot = selectedRobots(available, selector)[0];
    const managed = new Set(loadRobotFilterExemptions(db, robot.id).map((row) => normalizeFilterReason(row.reason)));
    const rules = new Map();
    for (const requested of requestedReasons) {
      const rule = resolveRequestedFilterReason(config, robot, requested);
      const reason = normalizeFilterReason(rule.reason);
      if (!managed.has(reason)) {
        db.close();
        fail(`Robot '${robot.name || robot.id}' has no managed exemption for '${rule.reason}'.`);
      }
      rules.set(reason, rule);
    }
    const remove = db.prepare("DELETE FROM robot_filter_exemptions WHERE robot_id = ? AND reason = ?");
    for (const [reason] of rules) remove.run(robot.id, reason);
    const updatedRobot = selectedRobots(mergedConfig(config, db), robot.id)[0];
    const companyOverride = publicCompanyFilterOverride(config, updatedRobot);
    const managedExemptions = loadRobotFilterExemptions(db, robot.id).map((row) => row.reason);
    db.close();
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        action: "restored",
        databasePath: DB_PATH,
        restoredRules: [...rules.values()],
        managedExemptions,
        companyOverride,
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "filter-add") {
    const keyword = args[0];
    if (!keyword || keyword.startsWith("--") || keyword.trim().length > 80) {
      fail("filter-add requires a keyword of 1 through 80 characters.");
    }
    const reason = normalizeFilterReason(optionValue(args, "--reason") || keyword);
    if (!reason) fail("The filter reason must contain at least one ASCII letter or number.");
    const pattern = optionValue(args, "--pattern") || defaultDenyPattern(keyword);
    try {
      new RegExp(pattern, "iu");
    } catch (error) {
      fail(`--pattern contains an invalid regular expression '${pattern}': ${error.message}`);
    }
    const db = openDatabase();
    const before = configWithManagedFilterOverrides(baseConfig, db);
    const existed = (before.notificationFilters?.excludeTitlePatterns || []).some(
      (rule) => rule.reason.toLowerCase() === reason,
    );
    const updatedAt = setManagedFilterOverride(db, reason, "upsert", pattern);
    const effectiveConfig = configWithManagedFilterOverrides(baseConfig, db);
    const summary = managedFilterSummary(baseConfig, effectiveConfig, db);
    const rule = summary.rules.find((entry) => entry.reason.toLowerCase() === reason);
    db.close();
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        action: existed ? "updated" : "added",
        databasePath: DB_PATH,
        rule,
        updatedAt,
        effectiveDenyKeywordCount: summary.rules.length,
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "filter-remove") {
    const requested = args[0];
    const reason = normalizeFilterReason(requested);
    if (!requested || requested.startsWith("--") || !reason) fail("filter-remove requires a filter reason.");
    const db = openDatabase();
    const before = configWithManagedFilterOverrides(baseConfig, db);
    const existing = (before.notificationFilters?.excludeTitlePatterns || []).find(
      (rule) => rule.reason.toLowerCase() === reason,
    );
    if (!existing) {
      db.close();
      fail(`No active deny filter has reason '${reason}'.`, "Run 'filter-list' to see active reasons.");
    }
    const updatedAt = setManagedFilterOverride(db, reason, "remove");
    const effectiveConfig = configWithManagedFilterOverrides(baseConfig, db);
    const summary = managedFilterSummary(baseConfig, effectiveConfig, db);
    db.close();
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        action: "removed",
        databasePath: DB_PATH,
        removedRule: existing,
        updatedAt,
        effectiveDenyKeywordCount: summary.rules.length,
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "robots") {
    try {
      const robots = await listRobots();
      const db = openDatabase();
      saveRobotSources(db, robots);
      db.close();
      process.stdout.write(`${JSON.stringify({ status: "ok", robots }, null, 2)}\n`);
      return;
    } catch (error) {
      fail(error.message, "Verify MAXUN_BASE_URL, the Docker network, and the API key.");
    }
  }
  if (command === "status") {
    if (!existsSync(DB_PATH)) {
      process.stdout.write(
        `${JSON.stringify({ status: "ok", databasePath: DB_PATH, totalStored: 0, current: 0, missingRecordedAt: 0, notificationStatusCounts: {}, autoConfiguredRobots: [], byTitle: [] }, null, 2)}\n`,
      );
      return;
    }
    const db = openDatabase();
    const totals = db
      .prepare("SELECT COUNT(*) AS totalStored, COALESCE(SUM(is_current), 0) AS current, SUM(CASE WHEN recorded_at = '' THEN 1 ELSE 0 END) AS missingRecordedAt FROM jobs")
      .get();
    const notificationStatusCounts = Object.fromEntries(
      db.prepare("SELECT notification_status, COUNT(*) AS count FROM jobs GROUP BY notification_status").all()
        .map((row) => [row.notification_status, row.count]),
    );
    const autoConfiguredRobots = loadAutoConfiguredRobots(db).map((robot) => ({
      id: robot.id,
      name: robot.name || robot.id,
      itemsPath: robot.itemsPath,
      fields: robot.fields,
    }));
    const byTitle = db
      .prepare("SELECT title, COUNT(*) AS openings, SUM(is_current) AS current FROM jobs GROUP BY title ORDER BY title COLLATE NOCASE")
      .all();
    db.close();
    process.stdout.write(`${JSON.stringify({ status: "ok", databasePath: DB_PATH, ...totals, notificationStatusCounts, autoConfiguredRobots, byTitle }, null, 2)}\n`);
    return;
  }

  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const valueFlags = new Set(["--payload-file", "--since", "--limit"]);
  const selector = args.find((arg, index) => !arg.startsWith("--") && !valueFlags.has(args[index - 1])) ||
    (flags.has("--all") ? "--all" : undefined);
  const useLatest =
    flags.has("--latest") || (["baseline", "sync-config"].includes(command) && !flags.has("--run"));
  const payloadFlag = args.indexOf("--payload-file");
  const payloadPath = payloadFlag >= 0 ? args[payloadFlag + 1] : undefined;

  if (command === "filtered-jobs") {
    const since = parseSince(optionValue(args, "--since"));
    const defaultLimit = Number.isInteger(config.outputLimit) && config.outputLimit > 0
      ? Math.min(config.outputLimit, 100)
      : 25;
    const limit = parseOutputLimit(optionValue(args, "--limit"), defaultLimit);
    if (!existsSync(DB_PATH)) {
      process.stdout.write(
        `${JSON.stringify({ status: "ok", databasePath: DB_PATH, timeField: "recorded_at", since, filteredCount: 0, returnedCount: 0, omittedFilteredCount: 0, filteredOutByReason: {}, decisionSources: {}, backfilledDecisionCount: 0, unknownDecisionCount: 0, filteredJobs: [], filteredPositionCount: 0, returnedPositionCount: 0, omittedFilteredPositionCount: 0, filteredJobsByCompany: [] }, null, 2)}\n`,
      );
      return;
    }
    const db = openDatabase();
    const available = mergedConfig(config, db);
    const robots = selectedRobots(available, selector);
    const history = filteredJobHistory(db, config, robots, since, limit);
    db.close();
    process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
    return;
  }

  if (command === "filter-preview") {
    if (!existsSync(DB_PATH)) {
      process.stdout.write(
        `${JSON.stringify({ status: "ok", currentCount: 0, wouldPassCount: 0, filteredOutCount: 0, filteredOutByReason: {}, filteredExamples: [], robots: [] }, null, 2)}\n`,
      );
      return;
    }
    const db = openDatabase();
    const available = mergedConfig(config, db);
    const robots = selectedRobots(available, selector);
    const preview = previewNotificationFilters(db, config, robots);
    db.close();
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }

  if (command === "sync-config") {
    const selectedConfigured = selector && selector !== "--all"
      ? config.robots.find(
          (robot) =>
            robot.id.toLowerCase() === selector.toLowerCase() ||
            String(robot.name || "").toLowerCase() === selector.toLowerCase(),
        )
      : null;
    if (selectedConfigured && jobSourceFor(selectedConfigured) !== "maxun") {
      fail(
        `sync-config applies only to Maxun robots; '${selector}' uses ${jobSourceFor(selectedConfigured)}.`,
        "Run scan for this company to validate its configured source adapter.",
      );
    }
    try {
      const synced = await synchronizeRobotConfigs(config, selector, useLatest, payloadPath);
      process.stdout.write(
        `${JSON.stringify({
          status: synced.result.needsReview.length > 0 ? "needs-review" : "ok",
          databasePath: DB_PATH,
          ...synced.result,
        }, null, 2)}\n`,
      );
      return;
    } catch (error) {
      fail(error.message, "Verify Maxun connectivity and the robot's latest successful result, then retry.");
    }
  }

  if (command === "inspect") {
    if (!selector || selector === "--all") fail("inspect requires one robot ID or configured name.");
    let available = config;
    if (existsSync(DB_PATH)) {
      const db = openDatabase();
      available = mergedConfig(config, db);
      db.close();
    }
    const configured = (available.allRobots || available.robots).find(
      (entry) => entry.id.toLowerCase() === selector.toLowerCase() || String(entry.name || "").toLowerCase() === selector.toLowerCase(),
    );
    const robots = [configured || { id: selector }];
    if (robots.length !== 1) fail("inspect requires one configured robot ID or name.");
    if (configured && jobSourceFor(configured) !== "maxun") {
      fail(
        `inspect applies only to Maxun robots; '${selector}' uses ${jobSourceFor(configured)}.`,
        "Run scan for this company to validate its configured source adapter.",
      );
    }
    try {
      process.stdout.write(`${JSON.stringify({ status: "ok", ...(await inspectRobot(robots[0], useLatest, payloadPath)) }, null, 2)}\n`);
      return;
    } catch (error) {
      fail(error.message, "Verify the robot ID and Maxun connectivity, then retry.");
    }
  }
  if (command !== "scan" && command !== "baseline") {
    fail(`Unknown command '${command}'.`, "Run with --help to see supported commands.");
  }
  let available = config;
  let autoConfiguration = { checked: 0, configured: [], needsReview: [] };
  const manuallySelected = selector && selector !== "--all"
    ? config.robots.find(
        (robot) =>
          robot.id.toLowerCase() === selector.toLowerCase() ||
          String(robot.name || "").toLowerCase() === selector.toLowerCase(),
      )
    : null;
  const shouldDiscoverMaxun = !manuallySelected || jobSourceFor(manuallySelected) === "maxun";
  if (config.autoConfigure === true && !payloadPath && shouldDiscoverMaxun) {
    try {
      const synced = await synchronizeRobotConfigs(config, selector, useLatest, undefined);
      available = synced.config;
      autoConfiguration = synced.result;
    } catch (error) {
      const db = openDatabase();
      available = mergedConfig(config, db);
      db.close();
      autoConfiguration.needsReview.push({
        reason: `Automatic robot discovery failed: ${error.message}`,
        nextAction: "Verify Maxun connectivity, then run 'sync-config'. Configured robots were still checked.",
      });
    }
  } else if (existsSync(DB_PATH)) {
    const db = openDatabase();
    available = mergedConfig(config, db);
    db.close();
  }
  const robots = selectedRobots(available, selector);
  const limit = Number.isInteger(config.outputLimit) && config.outputLimit > 0 ? Math.min(config.outputLimit, 100) : 25;
  const result = await runMonitor(command, robots, useLatest, payloadPath, limit, autoConfiguration, config);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "error") process.exitCode = 2;
}

main().catch((error) => fail(error.message, "Inspect the error, fix configuration or connectivity, and retry once."));
