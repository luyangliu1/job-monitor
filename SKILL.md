---
name: maxun-job-monitor
description: Monitor Maxun, SmartRecruiters, Greenhouse, and JobSpy job sources; persist and deduplicate openings; manage title filters and Maxun mappings; classify accepted jobs by experience and CV relevance; and deliver or query regional reports. Use for company ingestion, new-job scans, denied keywords, scraper retraining, ranked jobs, filtered history, or scheduled checks.
---

# Job Monitor

Use the deterministic helper for all monitoring. Do not compare source results in model context or maintain a separate memory list. Each company has exactly one retrieval source; normalized jobs from every source enter the same SQLite comparison and reporting pipeline.

## Commands

- Check for new jobs from every configured company source (executing Maxun robots and calling source APIs):
  `{baseDir}/scripts/job-monitor.mjs scan --all`
- Check one configured company by source ID or exact configured name:
  `{baseDir}/scripts/job-monitor.mjs scan <robot>`
- Consume each robot's latest successful Maxun run instead of starting a run:
  `{baseDir}/scripts/job-monitor.mjs scan --all --latest`
- Seed the current jobs as already seen, returning no job notifications:
  `{baseDir}/scripts/job-monitor.mjs baseline --all --latest`
- List available Maxun robots:
  `{baseDir}/scripts/job-monitor.mjs robots`
- Discover new Maxun robots and persist high-confidence job mappings:
  `{baseDir}/scripts/job-monitor.mjs sync-config --all`
- Discover robots by executing them when no successful stored run exists:
  `{baseDir}/scripts/job-monitor.mjs sync-config --all --run`
- Inspect candidate item arrays and fields for a robot's latest result:
  `{baseDir}/scripts/job-monitor.mjs inspect <robot> --latest`
- Show effective robot mappings and whether each comes from config, automatic inference, or managed state:
  `{baseDir}/scripts/job-monitor.mjs mapping-list [<robot>|--all]`
- Persist a corrected field while retaining unspecified mapping fields:
  `{baseDir}/scripts/job-monitor.mjs mapping-set Siemens --title 'Label 1'`
- Resolve an ambiguous, not-yet-configured robot directly from Maxun by exact ID or name and save the inspected fields:
  `{baseDir}/scripts/job-monitor.mjs mapping-set MERL-intern --title 'Label 2' --url 'Label 1' --location 'Label 3' --items-path 'data.serializableOutput.scrapeList.List Data 1' --company MERL`
- Update other supported mapping properties after inspection confirms them:
  `{baseDir}/scripts/job-monitor.mjs mapping-set Siemens --url 'Label 2' --location 'Label 3' --date 'Label 5' --job-id 'Label 7' --items-path 'data.serializableOutput.scrapeList.List Data 1' --company Siemens`
- Remove fields that no longer exist with `--clear-url`, `--clear-location`, `--clear-date`, or `--clear-job-id`. Always retain a title field.
- Remove a managed override and restore the underlying configured or inferred mapping:
  `{baseDir}/scripts/job-monitor.mjs mapping-remove Siemens`
- Show stored counts grouped by job title:
  `{baseDir}/scripts/job-monitor.mjs status`
- List the effective global deny-keyword rules and any company-specific exemptions:
  `{baseDir}/scripts/job-monitor.mjs filter-list`
- Inspect the effective deny rules for one company robot:
  `{baseDir}/scripts/job-monitor.mjs filter-list Entegris`
- Add or update a case-insensitive whole-word deny keyword, including its common plural by default:
  `{baseDir}/scripts/job-monitor.mjs filter-add buyer`
- Add a deny rule with an explicit reason or regular expression when the default literal rule is insufficient:
  `{baseDir}/scripts/job-monitor.mjs filter-add technician --reason technician --pattern '\btechn(?:ic|it)ians?\b'`
- Remove an effective deny rule by its reason:
  `{baseDir}/scripts/job-monitor.mjs filter-remove buyer`
- Exempt one company from a global deny rule while continuing to inherit every other current and future global rule:
  `{baseDir}/scripts/job-monitor.mjs filter-exempt Entegris senior`
- Restore a global deny rule for that company. A matching keyword such as `sr` resolves to the stable `senior` rule:
  `{baseDir}/scripts/job-monitor.mjs filter-restore Entegris sr`
- Preview notification filters against current stored jobs without changing state:
  `{baseDir}/scripts/job-monitor.mjs filter-preview --all`
- Show jobs suppressed by notification filters, optionally from a time window:
  `{baseDir}/scripts/job-monitor.mjs filtered-jobs --all --since 7d`
- Increase filtered-history output when explicitly requested:
  `{baseDir}/scripts/job-monitor.mjs filtered-jobs --all --since 2w --limit 100`
- Validate configuration without calling any job source:
  `{baseDir}/scripts/job-monitor.mjs config-check`
- Enrich and classify accepted current jobs, using durable retry state:
  `{baseDir}/scripts/job-pipeline.mjs evaluate --all-current`
- Bound preparation or evaluation to one logical source and region during a pilot:
  `{baseDir}/scripts/job-pipeline.mjs evaluate --source-id jobspy:us --region US --enrich-limit 5 --evaluation-limit 25 --batch-size 5`
- Deliver only already-evaluated jobs from that selected source and region:
  `{baseDir}/scripts/job-pipeline.mjs deliver --source-id jobspy:us --region US`
- Show content, evaluation, and delivery queue status:
  `{baseDir}/scripts/job-pipeline.mjs status`
- Produce a deterministic scheduled-delivery report by retrieving every configured company source:
  `{baseDir}/scripts/daily-report.mjs`
- Deliver that report directly to Telegram in safe, complete-message chunks:
  `{baseDir}/scripts/daily-report.mjs --telegram-target <chat-id>`

For a long-running `scan`, call `exec` with `yieldMs: 1000` and `timeout: 10800`. If it backgrounds, use `process` to wait for that same session; never start the scan twice.

Use `daily-report.mjs` for command-based cron delivery. It scans every enabled source, then invokes the durable description/evaluation/delivery pipeline. Ranked routes read completed database state rather than an in-memory scan response. Configure route IDs through deployment environment variables and set cron fallback delivery to `none`. Scan issues are sent to the compatibility target without treating a partial scan as complete.

For JobSpy, regional classification, description acquisition, scoped pilot commands, evaluation criteria, database tables, and Telegram route behavior, read [references/v2-pipeline.md](references/v2-pipeline.md).

## Workflow

1. Before the first scheduled check, run `baseline --all --latest`. If a configured robot has no successful run, run `baseline --all --run` once.
2. For an on-demand or OpenClaw-scheduled check, use `scan --all`. Use `--latest` only when Maxun itself already schedules its robots; API-backed companies are always retrieved live.
3. Every all-robot scan discovers new Maxun robots first. It stores only high-confidence mappings and seeds that same result as the robot's baseline so existing jobs are not announced as new. Prefer title + durable URL or ID; accept title + company + location only when the URL-less shape is unambiguous. Report every `autoConfiguration.needsReview` entry; never silently treat an uncertain robot as checked.
4. Read `newJobsByCompany`, which contains unique position titles and their links for newly discovered jobs that passed notification filters. Never include stored jobs from `status`.
5. If `newCount` is zero, say clearly that no new matching jobs were found. When `filteredOutCount` is nonzero, briefly state how many new jobs were archived but suppressed and summarize `filteredOutByReason`.
6. If `errors` is non-empty, report which company source failed and the provided next action. Do not present a partial scan as complete. A retrieval failure leaves that company's stored current-job state unchanged.
7. Format the normal response as one company heading followed by position names only. Render each name as `[Position title](URL)` when its URL is nonempty; do not print the raw URL separately. Do not show location, date, robot metadata, fallback labels, or other details unless the user explicitly asks for them. List a repeated title only once within a company.
8. Keep exactly one blank line between company blocks so channel chunking can split only after a complete company whenever possible. Never stop after the first message-sized chunk. If one company block alone would exceed about 3,500 characters, split only between complete position bullets and repeat its heading as `Company (continued)`; never split a position title or Markdown link.

For requests to review filtered jobs, run `filtered-jobs` with the requested time window. Read `filteredJobsByCompany` for the grouped linked titles. Use `recordedAt` from `filteredJobs` when the user asks when a job was recorded, and include `filteredReason` only when requested. `--since` accepts durations such as `7d`, `24h`, and `2w`, or an ISO timestamp.

The helper stores every normalized item in SQLite. Identity prefers a configured job ID, then a canonical job URL, then title + company + location. A source-page URL is added only to report output, never used as every item's identity. This keeps same-title openings in different locations distinct while retaining a title index for lookup.

When a scraper is improved to add a durable URL or ID, the helper upgrades a single matching current title + company + location row in place. Preserve its original first-seen time and do not announce the identity upgrade as a new job. Baseline after changing a robot's identity fields when the scraper's returned population also changed substantially.

## Notification Filters

Configure built-in global `notificationFilters` in `{baseDir}/config.json`. Each exclusion entry has a stable `reason` and a case-insensitive regular-expression `pattern`; `includeTitlePatterns` is an optional array of case-insensitive regular expressions. When inclusion patterns are nonempty, require at least one match. Exclusions take precedence.

For user requests to view or manage deny keywords, use `filter-list`, `filter-add`, and `filter-remove` instead of editing the read-only skill directory or creating a workshop proposal. These commands persist overrides in the bind-mounted SQLite database outside Docker. A managed addition replaces a built-in rule with the same reason; a managed removal can suppress a built-in rule. After a change, run `filter-list` to report the effective list and `filter-preview --all` only when the user asks to inspect its effect on currently stored jobs. Filter edits affect future discoveries and previews; do not rewrite historical notification decisions.

A robot may define its own `notificationFilters`. An array present on the robot replaces that global array; an omitted array inherits the global value. Use an empty array to disable one global filter type for that robot. Prefer `filter-exempt <robot> <reason>` for ordinary company exceptions: it subtracts only the named rule and keeps all other global rules, including rules added later. `filter-exempt` and `filter-restore` accept configured robot IDs or exact names, persist outside Docker, and accept either a stable rule reason or an unambiguous keyword matched by that rule. Run `filter-list <robot>` after changes and `filter-preview <robot>` only when the user asks to inspect the effect on current jobs.

Always archive newly discovered jobs before filtering notifications. Treat `discoveredNewCount` as all new archived openings, `filteredOutCount` as suppressed openings, `newCount` as the accepted opening count, and `newPositionCount`/`newJobsByCompany` as the linked-title notification result.

The `jobs.recorded_at` column is the immutable time an opening was first stored. Every new scan writes it, and schema migration backfills it from the existing `first_seen_at` value. Filter decisions and reasons are stored with each job so `filtered-jobs` can show historical suppressions. Rows created before this feature are classified once with the then-current filters and labeled with `filterDecisionSource: "backfill"`; later filter edits do not rewrite stored historical decisions. Use `filter-preview` when the user instead asks what the current rules would suppress now.

## Robot Shapes

With `autoConfigure` enabled in `{baseDir}/config.json`, `scan --all`, `baseline --all`, and `sync-config --all` inspect unknown Maxun robots. Latest mode reads stored runs; `--run` executes unknown robots and reuses that response for their baseline without executing twice. The inference logic recognizes descriptive field names and generic Maxun labels by URL shape, title uniqueness, location/date structure, structured job-card metadata, and common UI noise. Image and static-asset URLs are ignored as identity candidates. A high-confidence mapping is saved in SQLite. Strict URL-less inference requires an unambiguous title field and separate location or structured job-card context. If inference is uncertain or a retrained robot changes labels, use `inspect`, then `mapping-set`; do not edit the read-only skill directory or create a workshop proposal. `mapping-set` resolves an unconfigured robot from the live Maxun list by exact ID or name. For a newly discovered robot it requires title plus URL, job ID, or location, saves the mapping without ingesting anything, and returns the baseline command as its next action. Run that baseline only after checking the saved mapping. Run `mapping-list <robot>` and `config-check` afterward. Managed mappings persist in SQLite and override both checked-in and inferred mappings; `mapping-remove` restores the underlying mapping or removes the robot from the effective set when none exists.

Each robot can have a different `itemsPath`, field mapping, static company name, and identity fields. Set `itemsPath` to an array of paths when one robot returns multiple job lists; the helper combines them before normalization and deduplicates repeated identities. Stored and fresh Maxun responses use different envelopes; when `itemsPath` is absent, the helper selects a fallback only when the configured title and, when present, URL fields occur together. Never guess after inspection reports no high-confidence mapping.

## Job Sources

For a request to ingest, add, or start monitoring a new company, default to Maxun. Use a non-Maxun adapter only when the user explicitly names that source or provides source-specific configuration details, such as a SmartRecruiters API/job URL, company identifier, and country. A company name or ordinary career-page URL alone does not authorize guessing or switching to another adapter. When defaulting to Maxun, locate the live Maxun robot, inspect or configure its mapping as needed, and baseline it through the existing Maxun workflow.

Legacy robot entries without a `source` remain Maxun entries, so existing mappings do not need migration. An explicit Maxun entry may use `source: "maxun"` and `source_config.robot_id`, but its existing `id`, `itemsPath`, and field mappings remain supported. Maxun-only commands such as `robots`, `sync-config`, `inspect`, and `mapping-set` do not apply to API-backed companies.

Configure a SmartRecruiters company directly in the `robots` array:

```json
{
  "company": "Western Digital",
  "source": "smartrecruiters",
  "source_config": {
    "company_identifier": "WesternDigital",
    "country": "us"
  }
}
```

The SmartRecruiters adapter requests only public postings in the configured country, paginates with the API's 100-item limit, and retrieves each posting detail to obtain its public `postingUrl`. It returns only `name` and `url` to the common normalizer. It never uses the API `ref` as a job link. A malformed page, incomplete pagination, detail failure, or missing public posting URL fails the complete company retrieval before database state is updated.

Configure a Greenhouse company with its full hosted board URL:

```json
{
  "company": "SK hynix America",
  "source": "greenhouse",
  "source_config": {
    "board_url": "https://job-boards.greenhouse.io/skhynixamerica"
  }
}
```

The Greenhouse adapter parses the first URL path segment as the board token and requests `/v1/boards/{board_token}/jobs?content=true` from the public Greenhouse Job Board API. It retrieves the complete board once, including descriptions, without category configuration or per-job detail calls. It skips isolated malformed records with a compact warning. Invalid URLs, HTTP or JSON failures, a missing `jobs` array, or a wholly unusable nonempty response fail retrieval before database state is updated. A valid empty `jobs` array remains a successful empty board.

Required environment for Maxun companies: `MAXUN_API_KEY`. Optional test/runtime overrides: `MAXUN_BASE_URL`, `SMARTRECRUITERS_BASE_URL`, and `GREENHOUSE_BASE_URL`; each defaults to its public production service. The deployment mounts the skill read-only and bind-mounts `data/maxun-job-monitor/` from the OpenClaw project at `/var/lib/maxun-job-monitor`. Job history, inferred and managed mappings, filter overrides, and cached Maxun source-page URLs live in `/var/lib/maxun-job-monitor/monitor.sqlite`, outside the containers and image lifecycle.
