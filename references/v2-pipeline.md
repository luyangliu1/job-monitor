# Job Monitor v2 Pipeline

Read this reference when operating or debugging JobSpy retrieval, description
enrichment, LLM classification, regional queries, or ranked Telegram delivery.

## Stages

1. `job-monitor.mjs scan --all` retrieves each enabled source, normalizes jobs,
   and uses the existing SQLite identity/newness transaction.
2. Existing deterministic title filters run after storage. Filtered jobs remain
   stored and do not enter evaluation.
3. `job-pipeline.mjs` stores source-supplied descriptions or retrieves missing
   descriptions once with a temporary Maxun Markdown robot.
4. The tool-disabled `job-evaluator` OpenClaw agent classifies accepted jobs.
5. Classifications and audit evidence are stored before DB-driven Telegram
   routes enqueue and deliver jobs idempotently.

Failures after stage 1 never undo source comparison state. Missing descriptions
remain `unranked`; they are never guessed as irrelevant.

## Sources and Regions

Supported sources are `maxun`, `smartrecruiters`, `greenhouse`, and `jobspy`.
Each company uses exactly one source. Ordinary new-company ingestion defaults to
Maxun unless the user explicitly supplies another source and its configuration.

Maxun robot names must end in exact, case-insensitive `-US` or `-ROW`. The
suffix determines routing but is removed from the displayed company name. New
untagged robots are quarantined for review and are not executed. SmartRecruiters,
Greenhouse, and JobSpy entries use an explicit `region` field.

The enabled US JobSpy feed runs the two keywords separately:

- `process engineer`
- `chemical engineer`

Indeed receives quoted phrases; LinkedIn receives ordinary phrases. Searches
include remote jobs but are not remote-only. The configured ROW feed is disabled
until explicitly enabled after the US pilot. It covers Germany, United Kingdom,
France, Netherlands, Ireland, Denmark, Finland, Norway, Austria, Czechia,
Portugal, Belgium, Switzerland, Sweden, Japan, Canada, and Australia.

## Database

`jobs` retains its existing identity and comparison columns. v2 adds query
metadata only:

- `job_source`: retrieval adapter
- `region`: `US` or `ROW`
- `experience`: `unranked`, `entry`, or `senior`
- `relevance`: `unranked`, `relevant`, or `not_relevant`

Related tables are `job_content`, `job_evaluations`, and `job_deliveries`. They
provide retry state and audit history without changing job identity.

## Classification

Experience v1 treats no mentioned experience, no experience, or a required path
with a minimum of zero or one year as `entry`; `1-3 years` is entry. It treats
all acceptable required paths having minima of at least two years as `senior`.
Preferred experience alone is not senior, education alternatives use the least
experienced acceptable path, and ambiguity defaults to entry.

Relevance v1 is intentionally permissive. One substantive overlap with the
sanitized persistent profile is enough. The profile covers chemical/process
engineering; modeling, simulation, controls, safety, reliability, reactors,
instrumentation, experiments; Python/MATLAB/Aspen/COMSOL and related tools;
ML/AI/LLM/data work; and materials characterization.

## Routes

- `us_all`: accepted US Maxun, SmartRecruiters, and Greenhouse discoveries.
- `us_relevant`: US jobs classified `entry` and `relevant`, from every source.
- `row_relevant`: ROW jobs classified `entry` and `relevant`, from every source.
- `less_relevant`: either `senior` or `not_relevant`, from either region.

Keyword-filtered and unranked jobs remain queryable but are not sent to ranked
routes. Telegram IDs are deployment secrets and do not belong in the repository.

## Commands

```bash
scripts/job-monitor.mjs scan --all
scripts/job-pipeline.mjs prepare --all-current
scripts/job-pipeline.mjs evaluate --all-current --batch-size 5
scripts/job-pipeline.mjs deliver
scripts/job-pipeline.mjs status
scripts/daily-report.mjs
```

For a bounded source pilot, apply both selectors consistently:

```bash
scripts/job-monitor.mjs scan "JobSpy US"
scripts/job-pipeline.mjs prepare --source-id jobspy:us --region US --enrich-limit 1
scripts/job-pipeline.mjs evaluate --source-id jobspy:us --region US --enrich-limit 0 --evaluation-limit 5 --batch-size 5
scripts/job-pipeline.mjs deliver --source-id jobspy:us --region US
```

`--source-id` selects `jobs.robot_id`. The scope applies to content seeding,
description enrichment, evaluation, delivery queueing, and sending. Use
`evaluate`, rather than `run`, when classifications should be reviewed before
Telegram delivery.

The daily report performs the full enabled-source scan first, including JobSpy,
then executes enrichment, evaluation, and delivery from durable database state.

## Live US Pilot

The first no-proxy US run completed all four configured searches. It stored 456
unique direct-URL jobs from 498 site results; 136 were archived by deterministic
title filters and 320 were accepted for evaluation. All accepted Indeed rows had
native descriptions. LinkedIn returned no list descriptions, and the bounded
Maxun URL-scrape fallback successfully cached a description and removed its
temporary robot. The first five model decisions were reviewed, persisted, and
delivered through the ranked routes. The 08:00 America/Chicago command job now
runs this full pipeline; overlapping legacy `jobwatch-*` jobs are disabled. ROW
remains configured but disabled.
