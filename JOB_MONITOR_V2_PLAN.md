# Job Monitor v2: Description Evaluation and Regional JobSpy Sources

## Status

Implementation and fixture tests are complete. Live US migration/pilot and
scheduled promotion are the remaining rollout steps.
The existing SQLite comparison, new-job detection, title filtering, and Telegram
chunking remain the foundation.

## Goals

- Continue monitoring Maxun, SmartRecruiters, and Greenhouse sources.
- Add LinkedIn and Indeed discovery through `python-jobspy`.
- Store and compare jobs before spending resources on description enrichment or
  model evaluation.
- Store a job description once and reuse it for retries and later re-evaluation.
- Evaluate only newly discovered jobs with a dedicated, tool-restricted OpenClaw
  agent.
- Classify evaluated jobs along two independent dimensions: `experience` and
  `relevance`.
- Route reports by US/ROW region and relevance without changing existing job
  identity or comparison behavior.
- Preserve all state outside the OpenClaw Docker image.

## Processing Pipeline

```text
configured source or search feed
        |
        v
retrieve and normalize jobs
        |
        v
existing SQLite store/compare transaction
        |
        +--> known job: update last-seen state and stop
        |
        v
new job: create durable enrichment work
        |
        v
use source-supplied description or retrieve it once
        |
        v
store normalized description and content hash
        |
        v
dedicated OpenClaw evaluation agent
        |
        v
persist experience, relevance, evidence, criteria version, model, and timestamp
        |
        v
idempotent Telegram delivery and conversation queries
```

A failed description fetch, agent call, or Telegram delivery remains pending and
is retried independently. A failure is never converted into an empty successful
source result or a `not_relevant` decision.

## Runtime and Language Structure

The existing JavaScript monitor remains the orchestrator and the only SQLite
writer. Python is isolated to a private JobSpy service.

```text
OpenClaw gateway container
  maxun-job-monitor/
    scripts/job-monitor.mjs       existing source scan and DB comparison
    scripts/daily-report.mjs      scheduled orchestration and delivery
    scripts/sources/              Maxun/API source adapters
    scripts/enrichment/           description persistence and Maxun scraping
    scripts/ranking/              OpenClaw agent invocation and validation
    scripts/reporting/            regional/relevance routing
          |
          | internal HTTP, no host port
          v
JobSpy Python sidecar
  pinned Python image
  pinned python-jobspy version
  LinkedIn and Indeed retrieval only
```

The JobSpy sidecar must not write SQLite. This keeps database locking and
transaction semantics centralized in the existing JavaScript process. JobSpy
and its Python dependencies survive OpenClaw image upgrades because they live in
a separate versioned image.

## Database Decision

Use the existing local SQLite database for v2.

SQLite is sufficient because:

- one JavaScript process remains the database writer;
- scans and evaluations are scheduled workloads rather than high-concurrency
  interactive writes;
- the expected job volume is well within SQLite capacity;
- the existing comparison pipeline is already tested against SQLite;
- SQLite avoids adding MySQL credentials, network failure modes, migrations,
  and a second backup system.

Enable WAL mode, a busy timeout, foreign keys, appropriate indexes, and regular
recoverable backups. Store descriptions as normalized text with a configured
size limit and store a content hash separately.

Reconsider MySQL only if the system later has multiple concurrent writers,
multiple OpenClaw hosts, an external multi-user dashboard, or operational
requirements for replication/high availability. A running MySQL instance alone
is not a reason to migrate the comparison pipeline.

Add the two user-facing classification columns to `jobs` without using them in
job identity or new-job comparison:

```text
experience: unranked | entry | senior
relevance:  unranked | relevant | not_relevant
```

Existing rows initially receive `unranked`. The columns make conversation and
reporting queries simple. Keep detailed audit and retry metadata in related
tables rather than adding many evaluation-management columns to `jobs`:

```text
job_content
  source_id, item_key, description, description_source, content_hash,
  retrieved_at, status, attempts, last_error

job_evaluations
  source_id, item_key, criteria_version, experience, relevance,
  experience_evidence, relevance_evidence, model,
  evaluated_at, status, attempts, last_error

job_deliveries
  source_id, item_key, route, delivered_at, status, attempts, last_error
```

Queue state is durable in these tables. A job that was stored successfully but
could not be enriched or ranked is therefore retried even though it is no longer
new on the next source scan.

## Regions

### Existing sources

All existing sources are initially classified as US.

- Every live Maxun robot is renamed with the exact suffix `-US`.
- Maxun region parsing recognizes only exact, case-insensitive `-US` and `-ROW`
  suffixes.
- The suffix is removed from the displayed company name but the Maxun robot ID
  remains the stable source identity.
- Existing SmartRecruiters and Greenhouse entries receive `"region": "US"` in
  local configuration; their external identifiers and URLs are unchanged.
- Newly discovered untagged Maxun robots fail regional validation and are not
  executed until explicitly tagged. They must not silently default to a route.

The monitor exposes regional selection such as `scan --region US`,
`scan --region ROW`, and `scan --all-regions`. Maxun robots are filtered from the
API-provided robot list before execution; an external Maxun executable is not
required.

### JobSpy feeds

JobSpy is search-feed-oriented rather than company-oriented. Configure one
logical source per region, run its query matrix, merge the results, and
canonicalize exact URLs before passing the combined snapshot through the
existing comparison pipeline. This prevents the same board URL found by both
keywords from being inserted twice merely because two queries returned it.

Source-supplied company names are retained for report grouping. Cross-board
semantic deduplication is not performed initially because two companies can
legitimately have identical titles and one company can have multiple openings
with the same title. Prefer a direct employer URL when JobSpy supplies one;
otherwise retain the public LinkedIn or Indeed URL.

## JobSpy Search Matrix

Run each keyword as its own search. Do not combine the keywords into one Boolean
query.

Keywords:

- `process engineer`
- `chemical engineer`

Use quoted exact phrases for Indeed (`"process engineer"` and
`"chemical engineer"`) because Indeed also searches description text. Use the
ordinary unquoted phrases for LinkedIn.

US:

- Region: all United States locations.
- LinkedIn location: `United States`.
- Indeed country: `USA`.
- Do not restrict to a city or state.

ROW countries:

- Germany
- United Kingdom
- France
- Netherlands
- Ireland
- Denmark
- Finland
- Norway
- Austria
- Czechia
- Portugal
- Belgium
- Switzerland
- Sweden
- Japan
- Canada
- Australia

For each ROW country, set the LinkedIn location to the country and the Indeed
country to JobSpy's supported country value. Remote jobs are included, but the
search is not remote-only, so no remote-only filter is set.

This produces 72 site-level searches per complete cycle:

```text
2 keywords * (1 US region + 17 ROW countries) * 2 sites = 72
```

Run searches sequentially or with low bounded concurrency, add configurable
jitter between LinkedIn calls, and isolate failures by country/site/query.
Initially run LinkedIn without a proxy and record response status, result count,
duration, and rate-limit failures. Proxy support remains configurable for later
activation without a code change.

Use a rolling search window longer than the schedule interval so a delayed or
failed run does not create a coverage gap. Exact `hours_old`, result limits,
request pacing, and the first-run rollout size remain configuration decisions.

## Description Acquisition

- Indeed: retain the description returned by JobSpy for newly discovered jobs.
- LinkedIn: discover without full-description mode during the broad scan so old
  results do not cause one additional request per job on every run. Enrich only
  new LinkedIn jobs afterward.
- Maxun: use a temporary Maxun Scrape robot for a new job URL, request text or
  Markdown, store the result, and delete the temporary robot in `finally`.
- SmartRecruiters: reuse the posting-detail request already required to obtain
  `postingUrl`. Combine `jobAd.sections.jobDescription`, `qualifications`, and
  useful `additionalInformation` text as the description. Use Maxun only when
  those public API sections are missing or empty.
- Greenhouse: request the board list with `?content=true` and retain each job's
  `content` field. This preserves one board-level request and avoids per-job API
  calls. Use Maxun only when a particular job has no usable API content.
- Missing/non-job URL: mark content `unavailable` and retain a diagnostic. Never
  invent a description or ranking.

Normalize page text before storage and ranking by removing obvious navigation
noise and repeated whitespace. Store the normalized full text up to a safety
limit, its hash, retrieval source, and timestamp. Send a separately bounded
version to the model.

## Deterministic Filtering and Agent Evaluation

The existing case-insensitive, whole-word deny-keyword rules remain before the
LLM. Every new job is stored first. A denied job remains seen, records its filter
reason, and is not sent to description enrichment or ranking unless explicitly
requested for review.

Jobs that pass the deterministic filter are enriched and evaluated by a
dedicated OpenClaw agent with no shell, browser, messaging, or write tools. Job
descriptions are untrusted data, not instructions. Rows rejected by the keyword
filter retain `experience=unranked` and `relevance=unranked`; they are stored and
queryable through their existing filter status/reason but do not enter ranked
Telegram routes.

### Experience v1

Use a binary classification, with `unranked` reserved for jobs that could not be
evaluated:

- `entry`: explicitly entry level; explicitly no experience required; no
  experience requirement mentioned; or at least one acceptable required
  qualification path has a minimum of 0 or 1 years.
- `entry`: a required range such as `1-3 years`, because its minimum acceptable
  experience is 1 year.
- `senior`: every acceptable required path has a minimum of 2 or more years,
  including `2 years`, `2+ years`, `3-5 years`, or equivalent wording.
- Preferred/non-required years do not make a job senior by themselves.
- When education alternatives change the requirement, use the least-experienced
  acceptable path; for example, `BS + 3 years or PhD + 0 years` is entry.
- Ambiguous cases default to entry, matching the intentionally permissive v1
  policy.

### Relevance v1

Relevance is intentionally loose. Mark `relevant` when the responsibilities,
requirements, subject matter, or tools have at least one substantive overlap
with the supplied CV. False positives are acceptable during v1.

The CV-derived overlap areas are:

- chemical engineering, chemistry, process engineering, biochemical or
  industrial process work;
- process modeling, first-principles modeling, simulation, optimization,
  parameter estimation, sensitivity analysis, or numerical methods;
- process control, PID/control systems, digital twins, hybrid models, fault or
  anomaly detection;
- process safety, risk, reliability, resilience, cybersecurity, or
  cyber-physical systems;
- reactors, kinetics, experimental process operation, instrumentation, sensors,
  actuators, data acquisition, or design of experiments;
- Python, MATLAB/Simulink, LabVIEW, Aspen Plus, COMSOL, Maple, or Bayesian
  networks;
- machine learning, neural networks, AI, LLMs, agents, RAG, semantic search,
  NLP, data mining, data analysis, or data pipelines;
- materials science, nanomaterials, biomedical-materials research, synthesis,
  characterization, SEM, TEM, AFM, or XRD.

Mark `not_relevant` only when no meaningful overlap can be identified. Store a
short evidence phrase for both experience and relevance in `job_evaluations`.
The CV remains persistent private data outside the public source repository. A
sanitized ranking profile derived from it should omit contact information before
being sent to the model.

The agent returns validated JSON only:

```json
{
  "item_key": "stable item key",
  "experience": "entry | senior",
  "relevance": "relevant | not_relevant",
  "experience_evidence": "short requirement excerpt or explanation",
  "relevance_evidence": "short CV-overlap explanation",
  "criteria_version": "v1"
}
```

Evaluate in small batches with stable item identifiers. Missing, duplicated, or
invalid decisions remain pending. Record the model and criteria version so jobs
can be re-evaluated later without pretending the new decision was the original
one.

## Database-Driven Reporting and Telegram Routes

Scanning, description acquisition, evaluation, and reporting are separate
durable stages. Reporters query completed database state and never depend on the
in-memory `newJobs` response from the scan that happened to discover a job.

Four routes are planned:

1. US all-jobs channel (the existing channel): jobs from US Maxun,
   SmartRecruiters, and Greenhouse sources that passed the existing keyword
   filter. This compatibility feed does not wait for or depend on evaluation.
2. US relevant-entry channel: `region=US`, `experience=entry`, and
   `relevance=relevant`, across all configured sources including JobSpy.
3. ROW relevant-entry channel: `region=ROW`, `experience=entry`, and
   `relevance=relevant`, across all configured sources including JobSpy.
4. Non-relevant channel: evaluated jobs from either region where
   `experience=senior` or `relevance=not_relevant`.

An evaluated job belongs to exactly one of the two ranked outcomes: its regional
relevant-entry route, or the combined non-relevant route. `unranked` and
keyword-filtered jobs are stored and queryable but are not sent to a ranked
channel. A Maxun/SmartRecruiters/Greenhouse US job can intentionally appear once
in the compatibility all-jobs channel and once in one ranked channel because
delivery state is tracked independently by route.

Existing safe message chunking remains in use. Delivery is recorded per job and
route so a partial Telegram failure retries only unfinished delivery.

Conversation requests query stored state rather than implicitly rescanning. For
example:

- show entry-level relevant US jobs from the past week;
- show senior relevant ROW jobs since yesterday;
- show non-relevant jobs for a company;
- explain a job's experience and relevance decisions;
- show US Maxun jobs that passed or failed a particular keyword filter;
- retry jobs whose description or evaluation failed.

## Scheduling

Keep the main automation command-based. It performs deterministic discovery,
persistence, queued enrichment, ranking-agent calls, and delivery. Do not turn
the entire schedule into an agent-driven cron job: a model outage must not stop
source scans or lose newly discovered jobs.

The existing healthy daily Maxun command remains in place until v2 completes a
shadow run. New JobSpy and ranked routes are enabled only after baselining and
validation. Existing unrelated `jobwatch-*` agent cron jobs should be reviewed
and disabled after v2 proves equivalent functionality, to avoid duplicate work.

## Rollout Plan

1. Back up SQLite and export current configuration.
2. Add region validation and explicit region fields without changing delivery.
3. Rename all current Maxun robots with `-US`; verify robot IDs and mappings are
   unchanged, then label SmartRecruiters and Greenhouse entries as US.
4. Add the Python JobSpy sidecar and fixture-based adapter tests.
5. Add US and ROW logical JobSpy sources, query merging, exact URL deduplication,
   pacing, metrics, and partial-failure reporting. Configure the complete matrix
   but initially enable only US LinkedIn/Indeed searches.
6. Ingest the first JobSpy snapshot and enqueue all current, keyword-passing jobs
   for description acquisition and evaluation rather than silently baselining
   them.
7. Add durable description, evaluation, and delivery tables and retry commands.
8. Add one-time description enrichment and caching.
9. Add the tool-restricted evaluation agent with fake-agent tests and criteria
   versioning; verify its full initial classification before enabling delivery.
10. Configure Telegram destinations, validate chunking and delivery idempotency,
    and enable ranked routes.
11. Run Maxun/API/JobSpy integration scans, simulate failures at every stage,
    and confirm existing DB comparison behavior is unchanged.
12. Promote v2 to the daily schedule and retire overlapping legacy automation.

## Tests Required

- Exact Maxun `-US`/`-ROW` suffix parsing and rejection of untagged robots.
- Existing Maxun, SmartRecruiters, and Greenhouse regression tests.
- JobSpy country mapping, remote-inclusive behavior, two-keyword query expansion,
  and exact URL deduplication.
- Rate-limit, timeout, malformed-result, partial-country, and total-source
  failures without current-state corruption.
- Description storage, reuse, content hashing, safety limits, and retries.
- Only new, filter-passing jobs enter normal enrichment/ranking.
- Denied jobs remain stored and queryable.
- Invalid or partial agent JSON never becomes a completed decision.
- Criteria version changes and explicit re-evaluation.
- Region/relevance Telegram routing, safe chunking, and retry idempotency.
- Explicit first-run backfill evaluates all selected current jobs without
  altering their original first-seen/new-job history.

## Confirmed Defaults

Confirmed:

- Indeed uses quoted exact phrases; LinkedIn uses ordinary phrase searches.
- The complete ROW matrix is configured but the first live JobSpy pilot is US.
- LinkedIn initially runs without a proxy; blocking/rate-limit metrics determine
  whether a proxy is added.
- Description-unavailable jobs remain `unranked` and queryable.
- The initial selected-current-job population is evaluated rather than silently
  baselined.
- SmartRecruiters and Greenhouse are US until explicitly reconfigured.

- The initial evaluation backfill includes every currently active,
  keyword-passing Maxun/SmartRecruiters/Greenhouse job plus the first US JobSpy
  snapshot.
- A minimum acceptable requirement of 1 year is entry, while a minimum acceptable
  requirement of 2 years is senior; a `1-3 years` range is entry.
- JobSpy uses:
  72 hours; 200 US results per keyword/site; 100 ROW results per
  keyword/site/country; randomized 10-20 second LinkedIn delay.
- Descriptions retain at most 64,000 normalized characters and
  send at most 20,000 characters to the agent.
- The dedicated `job-evaluator` agent uses the configured OpenClaw model and
  fallbacks, with all tools denied and no skills.
- The three new Telegram channel IDs have been supplied and verified from
  private-channel message links. Store the numeric IDs only in deployment
  environment/configuration, not in this public source repository.
- Daily execution remains 08:00 America/Chicago.
- Retain job
  content/evaluations with job history, make daily SQLite backups, retain 30
  daily backups, and alert at 5 GB.
- Do not perform cross-board semantic duplicate suppression beyond exact direct
  URLs.
