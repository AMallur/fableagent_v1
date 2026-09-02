# Pre-pilot qualification

The test suites in this repository run one operation at a time, against small
fixtures, on a database that is recreated for every run. That is the right shape
for proving logic, and it is the wrong shape for answering the question a first
clinic deployment actually poses: **does this hold up under a real month's
volume, several people working at once, a failover mid-transaction, a restore
after a failure, and a clearinghouse that misbehaves?**

These five harnesses answer that. They are meant to be run against a disposable
database before a pilot, and re-run whenever something in the ingest, detection,
appeal or billing path changes.

| Harness | Command | What it answers |
|---|---|---|
| Load | `npm run qualify:load` | Which stage degrades first, and does anything degrade faster than the work grows |
| Concurrency | `npm run qualify:concurrency` | Can two people, or two jobs, corrupt the money by racing |
| Failure injection | `npm run qualify:faults` | Is the data still right after an operation is killed halfway |
| Disaster recovery | `npm run qualify:dr` | Does a restore reproduce the same money, provably |
| Payer simulation | `npm run qualify:optum` | Does the clearinghouse connector behave when the payer does not |

Every harness writes a JSON result and a Markdown report under
`engine/var/qualification/`, and exits non-zero when it finds something. None of
them needs credentials for an external service.

---

## Setting up a database to run against

```sh
bash db/rebuild_local.sh          # drops, migrates and seeds a local database
```

The script follows `.github/workflows/ci.yml` exactly, including the detail that
migrations run **as `rcm_runtime`**. That role owns the database and the public
schema, and its ownership is where its privileges come from — nothing grants
`rcm_app` to it. Running migrations as a superuser instead leaves every table
owned by `postgres` and the runtime role able to read nothing, which is a
failure that only the non-superuser RLS suite catches.

The harnesses mutate the seeded tenant, so rebuild between comparable runs.

`pg_stat_statements` is optional. With it, the load report attributes time to
individual statements, which is how the two quadratic queries described below
were found:

```sh
psql "$ADMIN_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
```

---

## 1. Load

```sh
npm run qualify:load -- --tenant <uuid> --client <uuid> \
  --batches 50 --claims-per-batch 100
```

Generates paired 837P and 835 documents and pushes them through the real
pipeline: ingest claims, ingest remittances, detect, build appeal packets, price
an invoice. Every stage is timed with percentiles, and the financial invariants
are checked at the end — a load run that corrupted the money is a failure however
fast it was.

The generator (`src/qualification/synthetic_x12.ts`) is deterministic, so a run
that finds a defect can be replayed exactly, and every remittance it emits
balances per TR3. That second property matters more than it sounds: a generator
that emitted unbalanced remittances would trip the balance policy on every file
and measure the rejection path instead of the pipeline.

**Finding the breaking point.** Run the same workload repeatedly against a
growing database. Cost that grows with accumulated history rather than with new
work is the failure mode that a single run cannot see, because it looks fine
until a client has been on the platform for a year:

```sh
for i in 1 2 3 4 5 6; do
  npm run qualify:load -- --tenant <uuid> --client <uuid> \
    --batches 20 --claims-per-batch 100 --seed $((i * 100000)) \
    --output-dir var/qualification/sweep_$i
done
```

Use a different `--seed` each time. The seed reaches the claim numbers, so runs
accumulate; with a fixed seed the second run updates the first run's claims and
the sweep silently measures nothing.

## 2. Concurrency

```sh
npm run qualify:concurrency -- --tenant <uuid> --client <uuid>
```

Runs several ingest workers, several detection runs, and several invoice writers
contending over the same month, then asks the invariants whether the money
survived. Failures are classified: a refusal the platform is supposed to produce
is a pass, anything else is reported as a defect rather than counted as one.

The check that matters most is the last line — how many invoices ended up
holding the contended period. More than one means the period was billed twice.

## 3. Failure injection

```sh
npm run qualify:faults -- --tenant <uuid> --client <uuid>
```

Requires `ADMIN_DATABASE_URL` to hold a role that can call
`pg_terminate_backend()`. Kills connections during invoice generation and during
ingest, then tries to rewrite the ledger, an issued invoice, and the audit log.

Each fault asserts on **state**, not on whether an exception was raised. That
distinction matters: `audit_log` carries policies for SELECT and INSERT only
under `FORCE ROW LEVEL SECURITY`, so an UPDATE from the application role reaches
no row and raises nothing at all. Asserting on the exception would have called a
working control broken. The harness therefore checks that the record did not
move, and separately proves the immutability trigger still fires when a
statement gets past row-level security — otherwise the second layer could rot
unnoticed until the day a policy is added.

## 4. Disaster recovery

```sh
npm run qualify:dr -- --tenant <uuid> --client <uuid>
```

**This drops and recreates the database named in `ADMIN_DATABASE_URL.`** It
refuses to run unless the database name looks disposable; the override flag is
deliberately verbose.

Takes a real `pg_dump`, destroys the database, restores it, and compares a
fingerprint: row counts, money totals, and content digests over the invoices,
the ledger and the audit trail — plus the evidence-pack hash a customer can
recompute themselves. Restoring onto a database that still exists would prove
much less, since the check could be satisfied by rows that were never lost.

Two ordering rules are baked in, and both were learned by getting them wrong:
exporting an evidence pack is itself an audited action, so the restored database
must be fingerprinted **before** a pack is exported from it, and the pack's date
window must end before the exercise so that the exercise's own audit rows fall
outside both packs. Without those, the harness reports a failed restore that it
caused itself.

The reported restore time is a measurement on the hardware it ran on. It is not
an RTO commitment, and `commercial/service_level_agreement.md` should not quote
it as one.

## 5. Payer simulation

```sh
npm run qualify:optum
```

No credentials, no network. Starts a mock payer on localhost and drives the real
connector (`src/integration/optum_client.ts`) against it over HTTP through the
failures a sandbox never produces: rate limiting, a mid-request hangup, an HTML
error page from a proxy, a token that expires sooner than the client caches it,
rejected credentials, a duplicate-claim rejection.

It speaks real HTTP on purpose. A stubbed `fetchImpl` would test the stub; this
exercises the client's own fetch, headers, retry timing and JSON handling.

Run this before asking for sandbox credentials, so the first live conversation
is about certifying a connector already known to behave.

---

## What these harnesses found

Recorded because the value of a harness is what it catches, and because each of
these would have been found by a customer otherwise.

| Finding | Severity | Status |
|---|---|---|
| Detection loaded every claim's documents with a correlated subquery, one full scan of the client's `document` table per claim — O(claims x documents), 18.5s and 10M buffer hits at 12k claims, growing for as long as a client stays | Serious | Fixed: aggregated once, `src/db/snapshot.ts` |
| Appeal context counted a payer's prior denials per case by rescanning every case the tenant had ever had — O(open cases x all cases) | Serious | Fixed: single grouped histogram, `src/appeals/context.ts` |
| `issueInvoice` checked status outside its transaction and updated without a guard, so concurrent issues all succeeded — 11 of 12 trials issued one invoice up to 8 times, each overwriting `issued_at` (the date payment terms run from) and appending another `invoice_issued` audit record | Serious | Fixed: conditional transition plus a bounded retry for number allocation, `src/web/billing.ts` |
| A checked-out `pg` client whose backend is terminated emits `'error'` with no listener, which ends the **process**, not the request. `pool.on('error')` does not cover it. A failover or an idle-in-transaction timeout during any transaction would take the server down | Serious | Fixed: `hardenPool` / `absorbConnectionErrors`, `src/db/connection.ts` and `src/db/tx.ts` |

Both quadratic queries were flat in the number of claims being processed and
grew only with what was already stored, which is why no existing test saw them:
every suite starts from an empty database.

Measured before and after, same 2,000-claim workload against a growing database:

| claims in table | detect before | detect after | appeals before | appeals after |
|---:|---:|---:|---:|---:|
| 2,081 | 8.2s | 6.3s | 8.9s | 7.8s |
| 6,081 | 22.4s | 5.9s | 10.8s | 7.7s |
| 12,081 | 32.2s | 8.5s | 19.2s | 7.4s |

## What they do not establish

- They run against synthetic claims. Real payer files carry denial codes, claim
  structures and edge cases this generator does not produce, and the accuracy of
  detection against real remittances is not what these measure.
- The load figures are from one machine with one database. They establish
  scaling shape — flat versus growing — not capacity on production hardware.

## Real Optum sandbox submission (2026-09-02)

The payer simulation above proves the connector handles *failures* correctly
against a mock. It does not prove Optum accepts our payloads — only the real
sandbox can. That step has now been run.

Using real Optum sandbox OAuth2 credentials (client-credentials flow against
`https://sandbox-apigw.optum.com/apip/auth/v2/token`) and Optum's own
[Sandbox Predefined Fields and Values](https://developer.optum.com/eligibilityandclaims/docs/sandbox-predefined-fields-and-values)
canned test identities, `submitProfessionalClaim` in
`src/integration/optum_client.ts` was driven over real HTTPS against
`POST /medicalnetwork/professionalclaims/v3/submission` (via
`.github/workflows/optum-sandbox.yml`, which holds the sandbox credentials as
environment-scoped GitHub secrets — nothing here required code changes to the
connector itself).

Result: **HTTP 200, `"status": "SUCCESS"`, `"editStatus": "SUCCESS"`.**

```json
{
  "status": "SUCCESS",
  "editStatus": "SUCCESS",
  "controlNumber": "000000001",
  "payer": {"payerID": "9496", "payerName": "EXTRA HEALTHY INSURANCE"},
  "claimReference": {
    "customerClaimNumber": "000000001",
    "rhclaimNumber": "12345",
    "submitterId": "12345",
    "formatVersion": "5010"
  }
}
```

This confirms `optum_client.ts`'s OAuth2 flow and `optum_mapping.ts`'s
`ClaimSubmissionRequest` field shape (`submitter`, `receiver`, `subscriber`,
`billing`, `claimInformation`, `serviceLines`) are correct against Optum's
actual API, not just the mock payer's approximation of it — no connector code
changed to get from the first 400 to this 200, only the test payload's
identity fields.

Two real Optum sandbox validation rules were discovered this way, useful for
anyone extending the mapping later:

- Every identity field (subscriber name, submitter/billing organization name,
  contact name, control numbers) must exactly match one of Optum's predefined
  canned sandbox values — arbitrary values are rejected with
  `"Please use predefined canned users for non-prod environments"`, even
  though the field is otherwise well-formed.
- `subscriber.gender` only accepts `'M'`, `'F'`, `'U'`, or `null` — uppercase.
- A billing provider with an `organizationName` still requires `employerId`
  (or `ssn`) **and** a full `address` block; omitting either fails
  `billing.validBillingProviderAdditionalInformation`.

This last rule caught a real mapping gap: `buildProfessionalClaimSubmission`
did not populate `billing.address`, because `ClaimSubmissionBundle` never
carried it even though `client.address` has existed in the schema since
migration `0010_appeals_and_ingest.sql` (used for the appeal letterhead).
`loadClaimSubmissionBundle`, the `ClaimSubmissionBundle.client` type, and
`buildProfessionalClaimSubmission` now all thread `client.address` through to
`billing.address`, with a regression test
(`test/optum_mapping.test.ts`) asserting it is present. This is fixed as of
this entry, not an open item — noted here because the sandbox test above
is what surfaced it; a real submission would otherwise have failed on this
exact rule for every client without foresight to notice the gap.

**What this does and does not close**, against required external gate 4 in
`PRODUCTION_READINESS.md` ("Implement and certify the selected
clearinghouse/payer connector"):

- Closes: proof the connector's transport, auth, and payload shape work
  against real Optum, not just a mock; the `billing.address` mapping gap the
  test surfaced.
- Does not close: Optum partner *certification* (a separate formal process,
  distinct from sandbox access), a production contract/BAA, and idempotency /
  acknowledgement-reconciliation behavior, which has only been proven against
  the mock's fault injection since Optum's sandbox does not offer fault
  injection.
