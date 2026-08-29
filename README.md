# Job Monitor for OpenClaw

A persistent OpenClaw skill that monitors company career sites and reports only newly discovered jobs. Each company uses exactly one retrieval source, while every source feeds the same SQLite comparison, filtering, and reporting pipeline.

Supported sources:

- Maxun robots
- SmartRecruiters Public Posting API
- Greenhouse Job Board API
- LinkedIn and Indeed through a pinned `python-jobspy` sidecar

## Features

- Stores every discovered job in SQLite before notification filtering.
- Reports only jobs not seen during previous successful scans.
- Preserves existing state when a source request fails.
- Uses public, browser-facing job URLs.
- Supports global deny filters and per-company exemptions.
- Groups report output by company and position title.
- Splits Telegram reports into complete, message-safe chunks.
- Automatically discovers and maps suitable new Maxun robots.
- Keeps job history and managed configuration outside the Docker image when mounted as documented below.
- Stores descriptions and classifies accepted jobs as entry/senior and relevant/not relevant.
- Routes US and ROW classifications through idempotent database-backed Telegram delivery.

## Installation

Place this repository in the OpenClaw workspace skills directory:

```text
~/.openclaw/workspace/skills/maxun-job-monitor
```

For Docker deployments, mount the skill read-only and persist its database separately:

```yaml
services:
  openclaw-gateway:
    environment:
      MAXUN_JOB_MONITOR_DB: /var/lib/maxun-job-monitor/monitor.sqlite
      JOBSPY_BASE_URL: http://jobspy:8765
      JOB_MONITOR_RELEVANCE_PROFILE: /var/lib/maxun-job-monitor/relevance-profile.md
    volumes:
      - ./job-monitor:/home/node/.openclaw/workspace/skills/maxun-job-monitor:ro
      - ./data/maxun-job-monitor:/var/lib/maxun-job-monitor
    depends_on:
      jobspy:
        condition: service_healthy

  jobspy:
    build:
      context: ./job-monitor/jobspy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=3)"]
```

Apply equivalent mounts to any separate OpenClaw CLI container that executes the skill.

## Environment

Maxun companies require:

```text
MAXUN_API_KEY
```

Optional endpoint overrides, primarily for self-hosted Maxun or testing:

```text
MAXUN_BASE_URL
SMARTRECRUITERS_BASE_URL
GREENHOUSE_BASE_URL
JOBSPY_BASE_URL
JOBSPY_TIMEOUT_MS
JOB_MONITOR_RELEVANCE_PROFILE
```

Ranked Telegram routes use these optional deployment variables. Keep their
numeric chat IDs in the deployment environment, not in this repository:

```text
MAXUN_JOB_REPORT_TELEGRAM_TARGET
JOB_MONITOR_US_RELEVANT_TARGET
JOB_MONITOR_ROW_RELEVANT_TARGET
JOB_MONITOR_LESS_RELEVANT_TARGET
```

No credentials are required for normal public SmartRecruiters, Greenhouse, LinkedIn, or Indeed retrieval.

## Evaluation Agent

Create a dedicated `job-evaluator` OpenClaw agent in persistent OpenClaw state.
Use the desired configured model, an isolated workspace, no skills, and no tool
access. The corresponding agent entry must retain this restriction:

```json
{
  "id": "job-evaluator",
  "skills": [],
  "tools": {
    "allow": [],
    "deny": ["*"]
  }
}
```

Set `JOB_MONITOR_EVALUATOR_AGENT` only when using a different agent ID. Job
titles and descriptions are treated as untrusted data in the evaluation prompt,
and the pipeline rejects incomplete or malformed classification output.

## Company Configuration

Companies are configured in [`config.json`](config.json). Older entries without a `source` property default to Maxun for backward compatibility.

### Maxun

```json
{
  "id": "maxun-robot-id",
  "name": "Dow",
  "itemsPath": "data.serializableOutput.scrapeList.List Data 1",
  "fields": {
    "title": "Label 2",
    "url": "Label 3"
  },
  "static": {
    "company": "Dow"
  }
}
```

Unless another source and its configuration are explicitly supplied, new-company ingestion defaults to Maxun.

### SmartRecruiters

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

The adapter applies the country filter through the API, paginates results, retrieves each posting detail, and uses its public `postingUrl`.

### Greenhouse

```json
{
  "company": "SK hynix America",
  "source": "greenhouse",
  "source_config": {
    "board_url": "https://job-boards.greenhouse.io/skhynixamerica"
  }
}
```

The adapter derives `skhynixamerica` from the board URL and requests the complete board from:

```text
https://boards-api.greenhouse.io/v1/boards/skhynixamerica/jobs
```

It makes no category-specific or individual job-detail requests.

### JobSpy

`JobSpy US` searches LinkedIn and Indeed separately for `process engineer` and
`chemical engineer`. Indeed phrases are quoted, the search window is 72 hours,
and remote jobs are included without making the search remote-only. A complete
ROW matrix is checked in but disabled for the initial pilot.

Indeed currently supplies descriptions with its search results. LinkedIn list
results are stored immediately, then missing descriptions are acquired once and
cached through the Maxun URL-scrape fallback before classification.

## Usage

Run commands from the repository root.

Validate configuration:

```bash
scripts/job-monitor.mjs config-check
```

Baseline all current jobs without announcing them:

```bash
scripts/job-monitor.mjs baseline --all --latest
```

Scan every configured source for new jobs:

```bash
scripts/job-monitor.mjs scan --all
```

Scan one company:

```bash
scripts/job-monitor.mjs scan "Western Digital"
```

List or synchronize Maxun robots:

```bash
scripts/job-monitor.mjs robots
scripts/job-monitor.mjs sync-config --all
```

List and manage deny filters:

```bash
scripts/job-monitor.mjs filter-list
scripts/job-monitor.mjs filter-add buyer
scripts/job-monitor.mjs filter-remove buyer
scripts/job-monitor.mjs filter-exempt Entegris senior
```

Review previously filtered jobs:

```bash
scripts/job-monitor.mjs filtered-jobs --all --since 7d
```

See [`SKILL.md`](SKILL.md) for the complete command and workflow reference.

Prepare and classify one logical source without touching another source's
pending work:

```bash
scripts/job-pipeline.mjs prepare --source-id jobspy:us --region US --enrich-limit 5
scripts/job-pipeline.mjs evaluate --source-id jobspy:us --region US --batch-size 5 --evaluation-limit 25
scripts/job-pipeline.mjs deliver --source-id jobspy:us --region US
```

`--source-id` is the stable `jobs.robot_id` value. Pipeline scoping applies to
content preparation, URL enrichment, evaluation, delivery queueing, and sending.

## Scheduled Telegram Report

The report helper performs a full enabled-source scan, including Maxun,
SmartRecruiters, Greenhouse, and JobSpy, then runs durable enrichment,
classification, and route delivery:

```bash
scripts/daily-report.mjs --telegram-target <chat-id>
```

It sends sequential Telegram messages no longer than the configured safe limit and does not split a position title or Markdown link.

## Normalized Source Identity

Every adapter provides the existing identity fields:

```js
[
  {
    name: "Process Engineer",
    url: "https://example.com/jobs/process-engineer"
  }
]
```

Adapters may also provide a description and source metadata for internal
classification storage. Those fields do not change identity or reporting. The
existing shared pipeline still performs identity calculation, persistence,
new-job detection, notification filtering, and reporting from the common job
record.

## Tests

Requires a Node.js version that provides `node:sqlite`, native `fetch`, and `AbortSignal.timeout`.

```bash
node scripts/job-monitor.test.mjs
node scripts/daily-report.test.mjs
node scripts/sources/smartrecruiters.test.mjs
node scripts/sources/greenhouse.test.mjs
node scripts/sources/jobspy.test.mjs
node scripts/job-pipeline.test.mjs
```

The tests use temporary databases and local or mocked HTTP responses; they do not modify the production monitoring database.
