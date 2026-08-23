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
  notified either way. See **Recovery attribution** below for what counts as
  recovered.
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
│   ├── storage.ts         # DocumentStore (filesystem, GCS, and S3 implementations)
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
npm test                                      # unit/regression tests (current count printed by runner)
TEST_DATABASE_URL=postgres://... npm run test:integration   # integration, real Postgres
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
DTM/SVC/CAS/AMT/LQ/PLB for 835, HL/SBR/CLM/HI/REF/SV1/DTP for 837P. CSV
remittance exports parse with header aliasing, quoted fields, US dates, and
per-line error reporting.

**835 financial integrity.** Three things in an ERA move money that a
claim-only reading of the file never sees, and all three are handled:

- **PLB — provider-level adjustments.** Recoupments (`WO`), forwarding
  balances (`FB`), interest (`L3`/`L6`), capitation, penalties and refunds
  never appear on a CLP claim. They land in `remittance_provider_adjustment`,
  categorized, and linked back to the claim the payer recouped by the ICN in
  PLB03-2 when we can find it. A payer takeback is a visible fact, not a
  silent shortfall in the deposit.
- **Reversals (`CLP02 = 22`).** A reversal undoes an earlier adjudication
  and carries negative amounts. It is stored (`is_reversal`), its cash nets
  against what was already posted, and it never becomes a recovery case or
  flips a claim's status — a reverse-and-reissue pair is judged on the
  replacement, not on the reversal.
- **Payer re-coding and unit reduction.** SVC01 is what the payer
  *adjudicated*; SVC06 is what we *submitted*. The submitted code is what
  identifies our claim line, so that is what matching and pricing use, with
  the adjudicated code kept alongside and `payer_recoded` set when they
  differ. SVC07 (submitted units) is preferred over SVC05 (paid units) for
  the same reason — otherwise a payer cutting 3 units to 1 makes the shortfall
  disappear. CAS quantities are preserved too.

**835 balancing** (`src/ingest/balance835.ts`, pure) enforces the three X12
balancing rules on every file before anything is written:

| Rule | Check |
|---|---|
| service line | `SVC02 − Σ(line CAS) = SVC03` |
| claim | `CLP03 − Σ(claim CAS + all line CAS) = CLP04` |
| transaction | `Σ CLP04 − Σ PLB = BPR02` |

A file that fails is **rejected and nothing is written** — the whole file, not
just the offending check, because half of a check that does not add up is
worse than none of it; the failed `system_job` row carries the arithmetic.
`CLP05` disagreeing with the PR adjustments is a warning rather than an error
(patient liability never moves provider cash, but variance detection should
fail closed for that claim).

Per client, under Client Administration → Organization profile:
`era_balance_policy` (`strict` rejects, `warn` loads and marks the remittance
`out_of_balance`) and `era_balance_tolerance` (per-check dollars, default 0).
Relax only for a trading partner whose rounding quirk you have documented.
The manual-upload preview uses the same tolerance the commit will, so a file
is never previewed clean and then rejected.

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
resolves by procedure code (the *submitted* one — see payer re-coding above),
preferring an exact billed-amount match. Unmatched lines are stamped
`match_method='unmatched'` — the manual-review queue is a partial index away.
Claim status from remit: `denied` (nothing paid + hard denial code), `paid`
(anything paid; Step 3 refines to `underpaid`), else `accepted`. Reversal
entries are excluded from status determination: reading their negative amounts
as a fresh result would flip a legitimately paid claim, and the claim-status
vocabulary has no term for "the payer took the money back," so a
reversal-only remit leaves the status alone and is surfaced in the run
summary instead.

**Step 2 — pricing.** Contract selected for client+payer effective at DOS
(latest wins); contract line by procedure + modifier (exact modifier beats
generic). `percent_of_medicare` prices off `medicare_fee_schedule`;
`fee_schedule` off the line's allowed amount; no contract falls back to the
Medicare rate as proxy with `expected_source='medicare_proxy'` (the
`no_contract` flag). A contract with a fee-schedule gap also proxy-prices but
is not flagged `no_contract`.

Two adjustments then apply to whatever rate was found, and both exist to stop
the engine inventing shortfalls that were never owed:

- **Modifier percentages** (`modifier_payment_rule`). A second procedure with
  modifier 51 pays 50%, a bilateral 50 pays 150%, an assistant 80 pays 16%.
  Pricing these at 100% made every modified line look half underpaid. Rules
  compose multiplicatively in `apply_order` — a bilateral assistant is 150%
  then 16%, not 166%. Seeded with the CMS percentages as shared defaults; a
  tenant, or tenant+payer, row overrides them. True MPPR ranking by RVU across
  the claim is **not** modeled: modifier 51 applies its configured percentage,
  which is how contracts state the term.
- **Lesser of billed** (`contract.apply_lesser_of_billed`, default on). Nearly
  every contract owes the lesser of billed charges and the contracted rate, so
  a line billed below the rate was never going to pay the rate. Comparing it
  against the rate manufactured a variance out of the provider's own charge
  master.

**Step 3 — variance.**

```
expected_payer_amount =
    (allowed - patient_responsibility - prior_payer_paid) x (1 - payment_reduction)
variance = expected_payer_amount - cumulative_paid
```

Any positive variance marks the line `underpaid`; a case candidate needs > $25
**or** > 5% of expected. Lines with denial codes route to classification
instead — never double-counted. Reversal entries are skipped entirely: their
amounts are negative and already netted into cumulative cash, so scoring them
as an adjudication would manufacture a full-billed-amount "underpayment" out of
an accounting entry.

The last two terms are what stop the engine billing a payer for money it never
owed:

- **`prior_payer_paid`** applies on a secondary or tertiary claim. The primary
  has already settled part of the allowed amount; without subtracting it every
  secondary claim reads as massively underpaid. Sourced in order of precision:
  line-level COB detail (837 loop 2430 `SVD02`), the claim-level COB total
  (loop 2320 `AMT*D`), and finally the payer's own `OA-23` "impact of prior
  payer adjudication" on the remit line. Only consulted when the claim is known
  to be secondary or tertiary (`claim.payer_sequence`, from `SBR01`) — guessing
  coverage order from an OA-23 alone would subtract real money from a primary
  claim and hide a genuine underpayment.
- **`payment_reduction`** (`payer.payment_reduction_percent`) is Medicare
  sequestration and its equivalents: a percentage withheld from the payment
  after adjudication, which is why it multiplies the payer's liability rather
  than the allowed amount. Set it to `2.000` on Medicare payers. Left at zero it
  fires on every Medicare line and, with five or more of them, trips the
  `systemic_underpayment` anomaly against a payer that is paying correctly.

**Step 4 — classification.** Codes normalize to `CO-45` form from any of
`45`+group, `CO45`, `co-45`. The contractual codes (CO-45, CO-131) carry
`requiresVariance`: they appear on virtually every clean remit as the normal
contractual write-off, so they only become cases when payment is actually
below the expected amount. `OA-23` and `CO-253` carry it for the same reason —
`OA-23` is the payer reporting what the *prior* payer did and appears on
essentially every line of every secondary claim, and `CO-253` is statutory
sequestration, which is not appealable. CO-97 reclassifies from coding to bundling when a
sibling line on the same claim was paid (the "included in primary procedure"
context), and a bundling denial is then checked against the **CMS NCCI edit
tables** — see below. Unmapped codes produce a low-likelihood manual-review
candidate rather than being dropped. Deadline = remit check date + payer
`appeal_deadline_days` (default 90).

**NCCI procedure-to-procedure edits.** A bundling denial is the one denial
where the payer's own rulebook is public, so the platform reads it rather than
telling a biller to go and check. The denied line is the column-two code; a
paid sibling on the same claim is the column-one candidate; `claim.claim_type`
picks the practitioner or outpatient-hospital table. Six findings, and only two
of them are "append modifier 59 and appeal":

| Finding | What it means | Effect |
|---|---|---|
| `never_separately_payable` | Edit in force, **modifier indicator 0**: no modifier can override it, ever | Likelihood `low`, score −35, and the recommendation says plainly not to appeal for unbundling. A `59` on the line does not change this — billing one against an indicator-0 pair is itself a coding problem |
| `override_billed_and_ignored` | Indicator 1 and we billed `59`/`XE`/`XP`/`XS`/`XU` (or another CMS PTP-associated modifier); the payer bundled anyway | Likelihood `high`, score +20 |
| `override_available` | Indicator 1, no bypass modifier billed | Unchanged (`medium`): the edit was applied correctly on what was submitted; the route is a corrected claim where the record supports a distinct service |
| `edit_not_in_force` | Indicator 9, or an edit whose effective/deletion dates do not cover the date of service | Likelihood `high`, score +15 |
| `no_edit_published` | CMS publishes nothing for the pair | `high` against a payer that adjudicates on NCCI (it contradicts their own policy); `medium` against one set to `payer.bundling_edit_source = 'proprietary'`, where the play is to demand the edit rationale under the contract |
| `no_reference_data` / `reference_predates_service` | No NCCI table imported, or the loaded quarter starts after the service | Nothing is concluded and the score does not move. "CMS publishes no edit" and "we have not loaded the file" are different statements and are never reported as the same one |

The finding is written to the case timeline as evidence, not just folded into a
score. Load the quarterly CMS file with
`node src/cli.ts reference-import --kind ncci_ptp --service-setting practitioner`;
until then bundling denials behave exactly as they did before. Only the newest
imported dataset per setting is consulted — the CMS files are cumulative
quarterly replacements, and mixing two would revive withdrawn edits. Edits are
loaded narrowly per run (only pairs whose both sides appear on the run's
claims), because the published tables run to millions of rows.

Per client, `client.ncci_bundling_policy` decides what to do with an
indicator-0 finding: `advisory` (default) still opens the case carrying the
warning; `suppress_unappealable` does not open it at all and logs a
`ncci_not_separately_payable` skip with the amount, so the money is still
visible without sitting on a worklist as though it were recoverable.

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
created+updated cases. Anomalies: a payer paying below contract on ≥ 80% of at
least 5 contract-priced lines flags `systemic_underpayment`; reversed service
lines flag `payment_reversed` per payer, and `summary.reversals` carries the
count, dollars and claim lines — a run that only counts money owed to the
client would otherwise render a takeback invisible. Clients whose
identified recovery exceeds `client.recovery_alert_threshold` get an alert
entry in the summary (delivery itself belongs to a `send_alerts` job — the
engine only identifies).

## Recovery attribution

A recovered dollar is one the appeal actually produced. That is not the same
as "cash arrived after we submitted," and the difference is what an invoice
has to survive being audited against the customer's own remittances.

`reconcilePaymentsInner` attributes on four rules:

1. **Line scope.** A case is opened on a claim *line*, so attribution is
   line-scoped. Payment landing on a sibling line of the same claim is not
   this case's recovery. The one deliberate widening: remittance detail the
   payer never resolved to a service line (a header-only ERA row) is
   attributed for want of anything better and reported separately as
   `unallocated_paid` — the part of an invoice line a customer is most likely
   to question, and the part an operator can go and resolve properly.
2. **Reversals net.** A reverse-and-reissue pair re-pays the original amount
   plus the correction; only the net movement is recovery. Billing the gross
   reissue would charge the customer for money they already had.
3. **Recoupments net.** A PLB takeback referencing the claim after the appeal
   went out is cash moving the other way and comes off the total.
4. **Only what this reconciler attributed can be reversed.** When a payer
   takes money back, the clawback is capped at the recovery this arithmetic
   itself credited. A payment a biller verified and matched by hand is never
   undone by a robot — the operator is notified and the case timeline records
   the takeback instead. A negative delta with no reversal and no recoupment
   behind it is a bookkeeping difference, not a takeback, and is left alone.

Every component is stored on `payment_event` — `pre_appeal_paid`,
`gross_post_appeal_paid`, `unallocated_paid`, `reversals_netted`,
`recoupments_netted`, `attribution_basis`, `attribution_scope` — so a
recovery line can be defended figure by figure rather than asserted.

### Attribution policy

Which post-appeal dollars count is a **commercial term, not an engineering
constant**, so the five decisions above that a contract can legitimately state
differently are per-client configuration on `client`. Every default is the
behavior described above, so no existing client's numbers move:

| Setting | Default | What changing it does |
|---|---|---|
| `attribution_basis` | `incremental_net` | `gross_post_appeal` credits every dollar paid after submission instead of the net movement. It over-credits a reverse-and-reissue by construction — opt in only where the contract says so. Recoupments net under both: a PLB takeback is not payment. |
| `attribution_window_days` | `NULL` (no limit) | Payment arriving more than N days after submission stops counting as the appeal's doing. Reversals are **never** windowed out — a late takeback still removes money we credited. |
| `attribution_min_amount` | `0` | Movement below this is treated as noise (rounding, a few cents of interest) and does not open a billable event. Never suppresses a takeback. |
| `attribution_include_unallocated` | `true` | Turning it off stops attributing remittance detail the payer never resolved to a service line. The amount is reported either way. |
| `clawback_policy` | `auto` | `flag_only` records and escalates a takeback but leaves the credited figure for a person — some contracts require that, because reversing a recovery moves an invoice that has already gone out. It escalates once, not nightly. |

Set them per client in **Settings → Organization profile**, or over the API
with `PATCH /api/admin/clients/:id`. A bad value is a readable 400, not a
constraint violation.

## Usage ledger

Invoices used to be computed from `payment_event` at the moment they were
generated. That table is live and operational — reconciliation revises it, a
clawback lands on it, an operator corrects a bad match — so the evidence behind
a bill that had already gone out could move underneath it. Freezing the invoice
totals stopped the bill changing; it did not make the bill **reproducible**.

`usage_event` is the append-only record of billable facts: one row per
`payment_event`, written once with the amount as it stood, carrying enough in
`detail` (claim number, payer, gross, unallocated, reversals, recoupments) to
re-derive the figure without the operational tables at all. A database trigger
refuses every update except `invoice_id`, and refuses deletion outright.

- **The sync is a scan-and-append**, not a write on every path that touches
  `payment_event`. Reconciliation, a manual match, a backfill and a correction
  all land as payment events; making each of them remember to write the ledger
  too is how ledgers end up incomplete. One idempotent pass, guarded by a
  unique index, cannot miss and cannot double. It runs at the end of
  reconciliation and again before an invoice is computed.
- **A correction is a new row.** A takeback is a negative
  `recovery_clawed_back` event, never an amendment of the original.
- **An invoice claims its rows.** The database refuses to move a row another
  invoice already holds, so two overlapping generations cannot bill the same
  recovery twice. Voiding an invoice releases its rows to be billed again and
  leaves the events themselves untouched — nothing that happened stops having
  happened because a bill was wrong.

`GET /api/admin/invoices/:id` returns the ledger behind the bill alongside its
lines; `GET /api/admin/clients/:id/billing/ledger` shows a client's whole
billable history, billed and not yet billed.

## Commercial terms

Recovery work is sold on contingency — a share of the money the client actually
got back — not per case. An invoice is therefore an assertion about someone
else's cash, so three things have to hold, and the schema enforces all three:

- **The basis is verifiable.** The contingency is charged on recovery this
  platform attributed and can defend line by line (see **Recovery attribution**
  above), never on an estimate. A plan set to the `verified` basis charges only
  on recovery a person confirmed.
- **Each recovery is billed once.** Invoices are built from the append-only
  **usage ledger** (below): `invoice_line` carries one row per `usage_event`,
  each of which may be claimed by exactly one invoice, so a re-run, an
  overlapping period, or a regenerated month cannot bill the same dollar
  twice. A negative event — a payer clawing money back — reduces the basis
  rather than being quietly kept.
- **An issued invoice does not change.** A database trigger refuses to alter
  the figures on anything past `draft`, or to delete it; corrections are made
  by voiding and reissuing, which releases that invoice's recoveries to be
  billed again. Before this, regenerating a month silently rewrote a bill that
  had already gone out.

`pricing_plan` holds the agreed terms, effective-dated, per tenant with an
optional per-client override: base fee, per-case fee, contingency percent,
minimum and maximum. A mid-term renegotiation is a new row, not an edit.
`POST /api/admin/clients/:id/billing/preview` computes a month without writing
anything. The legacy self-serve tier table (`PLAN_PRICING`) still renders a
tenant's `subscription_tier` but no longer decides what is billed.

**Subscription and feature enforcement.** `client.subscription_status` and
`client.features` used to be stored, toggled in the admin UI, and read by
almost nothing: a suspended client kept full web access and the scheduler kept
running their nightly processing, and every client got every feature regardless
of plan. Two database functions are now the single enforcement point —
`app.client_processing_enabled(tenant, client)` and
`app.client_feature_enabled(tenant, client, feature)` — used by the scheduler,
the web session layer and the public API alike. Both take the tenant explicitly
rather than reading the session GUC, because a check that returns "deny" in any
context that forgot to set it would silently switch features off. Tenant admins
are never locked out by these gates, so a suspended client can still be
reactivated.

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

For the managed-Postgres side specifically on GCP: `db/provision_cloudsql.sh`
creates a real Cloud SQL for PostgreSQL instance with HA (regional,
synchronous standby, automatic failover) and automated backups with
point-in-time recovery, then `docker-compose.cloudsql.yml` (a standalone
file — run it *instead of* `docker-compose.yml`, not layered on top) reaches
it through the Cloud SQL Auth Proxy instead of the local `db` container:

```sh
PROJECT_ID=... DB_PASSWORD=$(openssl rand -hex 24) bash db/provision_cloudsql.sh
# copy the two CLOUDSQL_* values it prints into .env, then:
docker compose -f docker-compose.cloudsql.yml up -d
```

Appeal packets/letters default to local disk (`FileSystemDocumentStore`) —
fine for one instance with a persistent volume, not fine once you run more
than one. Set `GCS_DOCUMENT_BUCKET` to move them to Cloud Storage instead
(`resolveDocumentStore()` in `src/appeals/storage.ts`); on GCE the VM's
attached service account is used automatically, no key file needed.

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

What this does *not* do: run a load balancer or real monitoring/alerting in
front of any of this — a single-VM `docker compose up` is the reference
deployment, not a highly-available one at the app layer (the database layer
is, via `docker-compose.cloudsql.yml`).
