# Job Monitor for OpenClaw

A persistent OpenClaw skill that monitors company career sites and reports only newly discovered jobs. Each company uses exactly one retrieval source, while every source feeds the same SQLite comparison, filtering, and reporting pipeline.

Supported sources:

- Maxun robots
- SmartRecruiters Public Posting API
- Greenhouse Job Board API

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
    volumes:
      - ./job-monitor:/home/node/.openclaw/workspace/skills/maxun-job-monitor:ro
      - ./data/maxun-job-monitor:/var/lib/maxun-job-monitor
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
```

No credentials are required for normal public SmartRecruiters or Greenhouse retrieval.

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

## Scheduled Telegram Report

The report helper performs a full `scan --all`, including Maxun, SmartRecruiters, and Greenhouse sources:

```bash
scripts/daily-report.mjs --telegram-target <chat-id>
```

It sends sequential Telegram messages no longer than the configured safe limit and does not split a position title or Markdown link.

## Normalized Source Output

API adapters return only:

```js
[
  {
    name: "Process Engineer",
    url: "https://example.com/jobs/process-engineer"
  }
]
```

The existing shared pipeline then performs identity calculation, persistence, new-job detection, notification filtering, and reporting.

## Tests

Requires a Node.js version that provides `node:sqlite`, native `fetch`, and `AbortSignal.timeout`.

```bash
node scripts/job-monitor.test.mjs
node scripts/daily-report.test.mjs
node scripts/sources/smartrecruiters.test.mjs
node scripts/sources/greenhouse.test.mjs
```

The tests use temporary databases and local or mocked HTTP responses; they do not modify the production monitoring database.
