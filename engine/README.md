# RCM Platform Services

Claims processing, recovery detection, and appeal automation for the RCM
platform. Runs against the schema in [../db](../db).

TypeScript on Node ≥ 22.18 (runs natively, no build step). Only dependency:
`pg`.

Four services share one architecture (pure logic core, thin Postgres edges,
`system_job` lifecycle around every run):

| Service | Job type | Entry |
|---|---|---|
| 835 ingest | `ingest_835` | `ingest835Job` / `cli.ts ingest-835` |
| 837P ingest | `ingest_837` | `ingest837Job` / `cli.ts ingest-837` |
| Detection engine | `run_detection` | `runDetectionJob` / `cli.ts detect` |
| Appeal generation | `generate_appeals` | `generateAppealPackets` / `cli.ts appeals` |

plus the read-side submission queue (`loadSubmissionQueue` / `cli.ts queue`)
and document retrieval (`findDocuments` / `findPackets`).

## Operational web interface (src/web/)

The daily working UI for billers and collectors — dependency-free `node:http`
server, session auth (scrypt + HMAC-signed cookies), server-rendered pages,
JSON APIs, hand-rolled SVG charts. Eight screens: dashboard (KPIs, top
payers/categories, 90-day identified/submitted/recovered trend, activity
feed, run-detection quick action), case queue (13 columns, 8 filter
dimensions, column sort, bulk assign/status, CSV export), case detail
(summary / claim+835 / appeal packet panels, inline letter, document upload
that refreshes the packet, electronic submit + mark-mailed, timeline with
notes and payer calls), 5-step appeal builder (claim search → classification
with taxonomy recommendation → checklist → deadline/assign → create+generate),
payer performance (with claim drilldown and MoM trend), denial analytics
(categories, codes, provider/procedure rates, avoidable-vs-unavoidable and
root-cause groupings, CSV/print export), payment reconciliation
(auto/manual/unmatched with manual match action), and team workload
(per-user cases/$, overdue, SLA, weekly productivity trend).

```sh
node scripts/seed_demo.ts     # demo tenant + 3 months of data through the real pipelines
npm run web                   # http://localhost:8787
# login: admin@meridianrcm.com / sarah@… / colin@… — password demo1234
```

Auth scoping: client-scoped users see their client; tenant users see all
clients. Every query carries tenant+client predicates (RLS backs it up under
the rcm_app role). Passwords are scrypt-hashed (migration 0011); sessions are
stateless signed cookies (12h TTL, `SESSION_SECRET` env in production).

## Automation & scheduling (src/automation/)

`npm run scheduler` runs the platform without manual triggers. The scheduler
ticks once a minute; each client is evaluated in its **own timezone**
(`client.timezone`, `client.nightly_run_time`), with `system_job`-based
guards preventing double runs across restarts:

- **Nightly processing** (per client, configurable time) — the 12-step
  sequence: pick up new 835/837 files from `client.ingest_folder` (processed
  files archive to `processed/`), ingest, match, price, detect, create/update
  cases, generate appeal packets, reconcile payments, alert on ≤2-day
  deadlines, write the `dashboard_snapshot` rollup, and record the full
  per-step breakdown on the `system_job` row.
- **Deadline monitor** (07:00 client time) — tiered sweep: ≤14 days warns
  assignee + admins; ≤7 days sends urgent alerts and escalates priority to
  critical; ≤2 days flags `same_day_action`; passed deadlines are marked
  `expired` with admin notification. Alerts dedupe per case/tier/day.
- **Payment reconciliation** (inside nightly, also standalone) — for
  submitted appeals with post-appeal remittances: gap closed → case `won`;
  partial → `payment_event` + timeline note, case stays open; assignee
  notified either way.
- **Weekly summary** (Monday 08:00 client time) — per-client email to admins:
  cases opened / appeals submitted / dollars recovered last week, cases
  expiring this week, top-5 action items.

**Rule engine** (`/rules`, admin only): WHEN trigger (case created, deadline
approaching ±days, payment received, status changed, document uploaded) AND
dropdown-built conditions (payer, denial category, recovery $, confidence,
case type) THEN actions (auto-assign, notify user/role, set priority, release
to submission queue, flag for review). Rules are stored in `automation_rule`,
fire from the services and web actions, and every execution lands in both
`rule_execution` and the audit trail (`action='rule_executed'`). One rule's
failure never blocks others; deadline rules fire once per case.

**Notifications** (`/notifications`): in-app center with unread badge,
per-user per-type preferences (in-app on/off; email immediate/digest/off),
and digest frequency (daily/weekly/off). Urgent alerts upgrade to immediate
email unless the user opted out. All email flows through the `email_outbox`
table — a transport adapter (SMTP/SES) drains it in production; the default
transport logs deliveries and every send stays auditable either way.

## Architecture

The core is a **pure function**: `runEngine(EngineInput) -> EngineResult`.
No I/O, no wall clock (the run date is `config.asOf`), fully deterministic.
Everything database-shaped lives at the edges:

```
engine/src/
├── types.ts               # EngineInput / EngineResult contracts
├── config.ts              # thresholds, money + date helpers
├── taxonomy.ts            # denial code taxonomy + normalization (Step 4 data)
├── steps/
│   ├── step1_matching.ts  # claim-remit matching + claim status from remit
│   ├── step2_expected.ts  # contract / % of Medicare / proxy pricing
│   ├── step3_variance.ts  # variance flags; denial routing
│   ├── step4_denials.ts   # classification -> case candidates + deadlines
│   ├── step5_scoring.ts   # appealability 0-100, likelihood, priority
│   ├── step6_case_rules.ts# dedup / threshold / expired / autopilot rules
│   └── step7_summary.ts   # totals, breakdowns, anomalies, client alerts
├── engine.ts              # runEngine — wires steps 1-7
├── db/
│   ├── snapshot.ts        # Postgres -> EngineInput (scoped tenant/client)
│   └── persist.ts         # EngineResult -> Postgres (one transaction)
├── service.ts             # runDetectionJob: system_job lifecycle around the engine
├── ingest/
│   ├── x12.ts             # X12 tokenizer (separators from the ISA envelope)
│   ├── parse835.ts        # 835 ERA -> structured remittance (pure)
│   ├── parse837.ts        # 837P -> structured claims (pure)
│   └── service.ts         # ingest835Job / ingest837Job
├── appeals/
│   ├── types.ts           # AppealCaseContext — the pure-side contract
│   ├── letter.ts          # appeal letter generator, one body per category (pure)
│   ├── corrected_claim.ts # CO-4/5/6 corrections with confidence scoring (pure)
│   ├── assembly.ts        # document plan, ready/draft, auto-submit/review (pure)
│   ├── storage.ts         # DocumentStore (filesystem impl; swap for S3 later)
│   ├── context.ts         # Postgres -> AppealCaseContext[]
│   ├── service.ts         # generateAppealPackets: packets + documents + links
│   └── queue.ts           # submission queue + document/packet retrieval
└── cli.ts                 # manual trigger (detect | appeals | queue | ingest-835 | ingest-837)
```

## Running it

```sh
# scheduled or manual — same entry points (DATABASE_URL selects the database)
node src/cli.ts ingest-837 --tenant <uuid> --client <uuid> --file claims.837
node src/cli.ts ingest-835 --tenant <uuid> --client <uuid> --file era.835
node src/cli.ts detect     --tenant <uuid> [--client <uuid>] [--as-of D] [--dry-run]
node src/cli.ts appeals    --tenant <uuid> [--client <uuid>] [--as-of D]
node src/cli.ts queue      --tenant <uuid> [--client <uuid>]
```

**Onboarding a real tenant.** There is deliberately no HTTP endpoint for this —
an unauthenticated "create a tenant" route would let anyone provision one, and
nobody can be authenticated into a tenant that doesn't exist yet. It's a CLI
command, run by whoever operates the platform:

```sh
node src/cli.ts create-tenant --name "Acme Billing Co" \
  --type billing_company \
  --admin-email admin@acme.com --admin-first Jane --admin-last Doe
```

This creates the `tenant` row and its first `tenant_admin` user (`status =
'pending'`), queues a real invite email through the normal `email_outbox` (it
sends once `SMTP_*` is configured and the scheduler is running — see
`resolveEmailTransport` below — otherwise the invite link is also printed to
stdout so you can hand it over directly), and records a `tenant_created`
audit event. The admin accepts via `/accept-invite?token=...` (sets their own
password under the same policy check as any other invite), then logs in —
hitting the MFA enrollment gate on first login like any other admin account,
since `tenant.enforce_mfa` defaults to `true` for real tenants (the demo seed
turns it off for convenience only). From there, everything else — adding
clients, inviting more users, configuring payers/integrations — goes through
the normal `/admin` UI and `inviteUser`/`createClient` APIs.

```ts
// from code (a scheduler / queue worker)
import { runDetectionJob } from './src/service.ts';
await runDetectionJob(pool, { tenantId, clientId });
import { generateAppealPackets } from './src/appeals/service.ts';
await generateAppealPackets(pool, { tenantId, clientId });

// pure, no database at all — pass data in, get output back
import { runEngine } from './src/engine.ts';
runEngine(input).casesCreated;                       // detection
import { generateAppealLetter } from './src/appeals/letter.ts';
generateAppealLetter(caseContext, attachments);      // letters
```

`runDetectionJob` inserts a `system_job` row (`run_detection`, `running`),
snapshots the tenant's unprocessed remittance lines (`match_method IS NULL`)
plus matching candidates, runs the engine, persists everything in a single
transaction, and completes the job row with stats and the JSON summary in
`log_output`. On failure the job row is marked `failed` with the error.
`--dry-run` runs the full pipeline and reports without writing.

## Tests

```sh
npm test                                      # 105 unit tests, all pure logic
TEST_DATABASE_URL=postgres://... npm run test:integration   # 159 tests, real Postgres
```

The web, automation, API, and admin suites run against the seeded demo tenant
and mutate it — run `node scripts/seed_demo.ts` before each integration pass.

## Integration & ingestion (src/integration/, src/web/public_api.ts)

**Inbound method 1 — SFTP drop.** Each client gets a drop folder
(`client.ingest_folder`, provisioned at `var/ingest/<client_id>` when unset);
the scheduler sweeps every tick. Files are typed by extension/content
(835/ERA, 837, CSV), ingested, and archived to `processed/<date>-<name>`;
failures move to `errors/<name>` with `errors/<name>.log` carrying the parse
error (the failed `system_job` row has it too).

The SFTP server is real and embedded (`src/integration/sftp_server.ts`, via
`ssh2` — `npm run` … `node src/cli.ts sftp-server`, or the `sftp` service in
docker-compose). One process, one port, per-client credentials issued from
the admin UI (Client Administration → Integration → "Generate new
credentials," shown once, scrypt-hashed at rest). Each client is confined to
their own folder — no read, delete, rename, or path-traversal escape; the
only permitted operation is dropping a flat file, which the sweep then picks
up exactly as if it arrived by hand. Deliberately narrower than a real
general-purpose SFTP server, because upload is the only legitimate use.
`test/sftp_integration.test.ts` drives a real `ssh2` client against a real
running instance of it — not a mock of either side.

**Inbound method 2 — manual upload.** The client admin page parses uploads
for a preview (transactions, payers, checks, claim/line counts, totals, and
a sample table) before anything is written; commit ingests and chains a
detection run. Accepts 835/837/CSV; PDF remittances attach as documents
(OCR of paper EOBs is out of scope and stated as such).

**Inbound method 3 — public API** (`/api/v1`, docs at `/api/v1/docs`,
OpenAPI at `/api/v1/openapi.json`): claims ingest (raw X12 or structured
JSON), remittances ingest (triggers matching + detection, returns the
detection summary), cases list/detail, external case actions, and a
recovery-summary for dashboard embedding. Per-client API keys (sha256-hashed,
shown once, scoped read/ingest), per-key per-minute rate limits with
Retry-After, and every call logged to `api_request_log`. Data isolation is
identical to the UI; API PHI reads land in the PHI access log.

**X12 parsing** is real EDI: ISA/GS envelope separator detection, multiple
ST/SE transaction sets per 835 file (one remittance per check), CLP/NM1/
DTM/SVC/CAS/AMT/LQ for 835, HL/SBR/CLM/HI/REF/SV1/DTP for 837P. CSV
remittance exports parse with header aliasing, quoted fields, US dates, and
per-line error reporting.

**Outbound (Phase-2 hooks).** `src/integration/connectors.ts` defines the
OutboundConnector interface with a registry: Waystar/Availity/Change
Healthcare (clearinghouse), payer portal, and PM/EHR write-back. Electronic
packet submission and case status changes dispatch through it today; the
shipped connectors record every attempt in `outbound_delivery`
(status `not_configured`) so the submission trail exists now and a live
integration only implements `send()`.

## Enterprise administration & security (src/security/, src/web/admin_api.ts)

**Portals.** `/admin` (tenant overview: per-client AUM/recovered/cases/users,
system health, SSO configuration, add-client with mandatory BAA
acknowledgment), `/admin/users` (invite with role + client scope, deactivate,
reset access, reassign, per-user activity log), `/admin/client/:id` (profile,
per-payer filing/deadline/portal/autopilot/review-threshold config, contracts
and document uploads, feature flags, subscription status, integration
settings with a manual EDI upload zone, billing with usage-based invoices and
plan changes, onboarding checklist), and `/compliance` (audit trail with
filters + CSV/print export, HIPAA PHI access log, system job log with re-run
for failed jobs, data-export approval queue).

**Security enforcement** (all database- or middleware-level, not UI-only):
tenant/client scoping on every query with forced RLS beneath it; 5-attempt
login lockout (15 min); TOTP MFA enforced for admin roles when
`tenant.enforce_mfa` is on (RFC 6238, secrets AES-256-GCM encrypted at rest);
password policy 12+ chars / 3 character classes, 90-day rotation for admins;
configurable session timeout (default 30 min, sliding renewal);
`FORCE_HTTPS=1` enables HTTPS redirect + HSTS + Secure cookies behind a TLS
proxy; `audit_log` is append-only via a database trigger (UPDATE/DELETE raise,
grants revoked); every PHI view writes a `phi_accessed` audit row through a
SECURITY DEFINER function; data exports by non-admins require admin approval,
and every request/decision/download is audited. Integration credentials
(SFTP) are AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY`; PHI columns rely
on storage-level encryption (TDE/encrypted volumes) — a deliberate decision,
since column-level crypto would break name search and remit matching.

**SSO.** Per-tenant SAML 2.0 (SP-initiated) with `@node-saml` handling
assertion signature validation: SP metadata at `/sso/metadata?tenant=…`,
login at `/sso/login?tenant=…`, ACS with JIT user provisioning and IdP
group → platform role mapping (most-privileged match wins).

**Onboarding.** Client creation requires BAA acknowledgment and seeds the
8-step checklist; steps 1–7 auto-complete from real data (profile fields,
payer configs, contracts, first 835, first detection job, first cases, team
members) and step 8 (admin review) is a manual sign-off. Progress shows on
the dashboard until complete.

Integration suites skip themselves when `TEST_DATABASE_URL` is unset.
`integration.test.ts` covers the detection service in isolation;
`pipeline_integration.test.ts` runs the whole platform on EDI fixtures
(837 → ingest → 835 → ingest → detection → appeal packets → queue →
retrieval, with idempotent re-runs at every stage);
`web_integration.test.ts` drives the HTTP interface end-to-end against the
seeded demo tenant (run `node scripts/seed_demo.ts` first) — auth, every
screen's data API, filters/sorts, and every mutating action.

## Appeal automation (appeals/)

**Letters.** `generateAppealLetter` renders the eight-section letter
(letterhead, payer appeal address, RE block, opening, category body, closing
with the appeal deadline, signature, enclosures). One body template per
category: medical necessity (guidelines + reconsideration request),
authorization (cites the auth number from the encounter), bundling (modifier
rationale + CMS NCCI), underpayment (contracted-vs-paid table with the
calculation), timely filing (original submission date + proof), duplicate
(original claim reference), coding (CPT/modifier rationale), plus a general
fallback for COB/eligibility.

**Document assembly.** Every packet gets the letter, an EOB summary generated
from remittance data, and a claim-lines detail. Category extras:
authorization docs (an attestation is generated from the encounter's auth
number when nothing is uploaded), medical records (never fabricated —
uploaded only), a contract excerpt generated from contract lines, and a
timely-filing submission record. All generated files go through the
`DocumentStore` and become `DOCUMENT` rows (`source='system_generated'`)
linked via `appeal_packet_document`. Packet is `ready` when nothing is
missing, `draft` otherwise with `missing_document_types` populated. Draft
packets are refreshed on the next run (a missing document may have arrived).

**Corrected claims.** CO-4/CO-6 add a modifier (25 for an E/M with a same-day
procedure at confidence 90; 59 with a paid sibling at 75; 59 unguided at 60);
CO-5 strips the inconsistent modifier at 70. Original and corrected fields are
stored as JSONB on `corrected_claim`; anything under 85 is flagged
`needs_manual_review`. The claim itself is never mutated by the generator.

**Routing.** `auto_submit` requires autopilot on for the client+payer, an
electronic submission method (portal/clearinghouse), confidence ≥ 0.85, and
no review flags. `needs_review` fires for medical necessity (always),
recovery above the client's `appeal_review_threshold`, a denial pattern with
no prior history for that payer+category, confidence < 0.85, or a
low-confidence correction — and review always beats autopilot. Submission
method: corrected claims → clearinghouse; payer portal when one exists;
otherwise mail.

## Ingest (ingest/)

Pure X12 parsers (separators auto-detected from the ISA envelope) feed
transactional loaders. The 835 loader creates `remittance` +
`remittance_line` rows carrying the matching hints (payer ICN, member ID,
DOS, CARC adjustments) — linking to claims is deliberately left to the
detection engine. The 837P loader upserts patients (by client+member ID) and
providers (by client+NPI, stubbing unknowns with a warning), and creates
encounters, claims, and lines. Unknown payers become tenant-scoped stub
records flagged in the job log. Both loaders are idempotent: duplicate 835
trace numbers and already-loaded claim control numbers are skipped.

## Pipeline decisions worth knowing

**Step 1 — matching.** Payer claim number (835 CLP07) first; fallback is
patient member ID + DOS + procedure + billed amount. Within a claim, the line
resolves by procedure code, preferring an exact billed-amount match. Unmatched
lines are stamped `match_method='unmatched'` — the manual-review queue is a
partial index away. Claim status from remit: `denied` (nothing paid + hard
denial code), `paid` (anything paid; Step 3 refines to `underpaid`), else
`accepted`.

**Step 2 — pricing.** Contract selected for client+payer effective at DOS
(latest wins); contract line by procedure + modifier (exact modifier beats
generic). `percent_of_medicare` prices off `medicare_fee_schedule`;
`fee_schedule` off the line's allowed amount; no contract falls back to the
Medicare rate as proxy with `expected_source='medicare_proxy'` (the
`no_contract` flag). A contract with a fee-schedule gap also proxy-prices but
is not flagged `no_contract`.

**Step 3 — variance.** `variance = expected - paid`. Any positive variance
marks the line `underpaid`; a case candidate needs > $25 **or** > 5% of
expected. Lines with denial codes route to classification instead — never
double-counted.

**Step 4 — classification.** Codes normalize to `CO-45` form from any of
`45`+group, `CO45`, `co-45`. The contractual codes (CO-45, CO-131) carry
`requiresVariance`: they appear on virtually every clean remit as the normal
contractual write-off, so they only become cases when payment is actually
below the expected amount. CO-97 reclassifies from coding to bundling when a
sibling line on the same claim was paid (the "included in primary procedure"
context). Unmapped codes produce a low-likelihood manual-review candidate
rather than being dropped. Deadline = remit check date + payer
`appeal_deadline_days` (default 90).

**Step 5 — scoring.** Category base score with the spec's context rules
(auth denial with an auth number on the encounter scores 85; duplicate denial
with no true duplicate in the claim set scores 85; timely-filing denial where
the submission date proves filing inside the payer window scores 65), then
adjusted for deadline proximity, prior win rate for the category+payer, and
whether supporting document types are on file. Clamped 0-100;
`confidence_score` = score/100; likelihood high ≥ 70, medium ≥ 40.

**Step 6 — case rules,** in order: existing open case for the claim line →
update it (never duplicate; a `case_action` note records the refresh); below
the $25 minimum (or the client+payer override) → skipped and logged; deadline
already passed → case created with `expired=true`, priority forced `low`,
never auto-actioned; client+payer autopilot on → `auto_action=true`, else
manual queue.

**Step 7 — summary.** Totals and category/payer/priority breakdowns over
created+updated cases. Anomaly: a payer paying below contract on ≥ 80% of at
least 5 contract-priced lines flags `systemic_underpayment`. Clients whose
identified recovery exceeds `client.recovery_alert_threshold` get an alert
entry in the summary (delivery itself belongs to a `send_alerts` job — the
engine only identifies).

## Money

All arithmetic goes through `round2` with a half-cent epsilon on comparisons
(`moneyGt`) — no raw float equality anywhere.

## Running this for real

`docker-compose.yml` and `Caddyfile` at the repo root are the deployment
reference: Postgres (dev/staging — point `DATABASE_URL` at a managed,
encrypted-at-rest instance for anything carrying real PHI), a one-shot
`migrate` service, the `app`, `scheduler`, and `sftp` containers, and Caddy
handling TLS termination automatically (real Let's Encrypt certs, HSTS, no
manual cert handling). `sftp` publishes port 2222 — map it to 22 at your
firewall/load balancer if clients expect the standard port.

```sh
cp .env.example .env    # fill in real values; .env is gitignored
docker compose up -d
```

Security posture, enforced in code rather than left to configuration
discipline:
- **HTTPS is mandatory whenever `NODE_ENV=production`** — no flag to
  remember (`FORCE_HTTPS=1` still exists as an explicit override for
  non-production environments that want it). See `requireHttps()` in
  `src/web/server.ts`.
- **`SESSION_SECRET` and `DATA_ENCRYPTION_KEY` are required in production** —
  the process refuses to boot without them (`src/security/secrets.ts`),
  rather than silently falling back to a dev value. Both support the
  `${NAME}_FILE` convention for Docker/Kubernetes secrets or any secrets
  manager that injects via a mounted file.
- **`/healthz`** is unauthenticated and checks real DB connectivity, not
  just that the process is listening — used by the Docker `HEALTHCHECK` and
  any external uptime probe.
- **Email notifications need SMTP configured to actually deliver** —
  unconfigured, they're logged, not sent (`resolveEmailTransport()` in
  `src/automation/notify.ts`). This is generic SMTP, so any provider works.
  **Do not point this at a real inbox until a BAA is signed with whichever
  provider owns `SMTP_HOST`** — these bodies carry PHI-derived content
  (patient names, case/claim detail), and an unsigned relay is a HIPAA
  violation independent of anything else being correct.

What this does *not* do: provision the managed Postgres instance itself — an
account with a cloud provider, no code can create that.
