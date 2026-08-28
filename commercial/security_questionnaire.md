# Security and vendor-risk questionnaire responses

The answers a clinic's IT security reviewer, a health system's vendor-risk team,
or a payer's third-party risk function will ask for.

**Every answer is verified against the code as cited, or explicitly marked as not
established.** Where a mature vendor would attach an attestation, this document
says that no attestation exists rather than describing a control and letting the
reader infer one. That distinction is the point: a reviewer can trust the answers
precisely because the gaps are named.

Last verified against commit `36d1ef3`.

---

## A. Company and scope

| # | Question | Answer |
|---|---|---|
| A1 | What does the product do? | Ingests X12 837 claims and 835 remittance advice, detects underpayments and denials against contracted rates, prepares appeal packets, and reconciles recovered payment. |
| A2 | Does it store PHI? | Yes. Patient demographics, member identifiers, dates of service, diagnosis and procedure codes, and claim financials. |
| A3 | Is a BAA required? | Yes, and it is enforced: a client cannot be created without a recorded BAA acknowledgement (`admin_api.ts`, HTTP 428), and go-live is blocked without it. |
| A4 | Third-party attestations | **None.** No SOC 2, HITRUST, ISO 27001 or independent penetration test. This is the most significant gap in this document. |
| A5 | Where is data processed? | A single AWS region selected at deployment. Terraform in `infra/aws/terraform/`. |

## B. Tenant isolation and access control

| # | Question | Answer |
|---|---|---|
| B1 | How is one customer's data isolated from another's? | PostgreSQL row-level security on every tenant-scoped table, with `FORCE ROW LEVEL SECURITY` so the table owner is not exempt. Policies compare `tenant_id` against a per-transaction setting. |
| B2 | Does the application run as a database superuser? | No. The runtime role is a non-superuser (`rcm_runtime`) and is verified as such by a dedicated regression suite (`test/rls_runtime.test.ts`), which also proves an unbound connection sees zero rows across client, invoice, ledger and pricing tables. |
| B3 | What happens if tenant context is not set? | Queries return nothing rather than everything. Verified by test, not by design intent. |
| B4 | Authentication | Email and password with a policy check, server-signed session cookies (HttpOnly, SameSite=Lax). |
| B5 | Multi-factor authentication | Required for administrative roles; enrollment is enforced before an admin session becomes usable. |
| B6 | Role model | Tenant admin, client admin, and operational roles, with per-client scoping. Cross-tenant access is not expressible in the session model. |
| B7 | Are credentials ever logged? | Log output is PHI-redacted (`docs/` logging standard; `test/logging.test.ts`). |

## C. Encryption

| # | Question | Answer |
|---|---|---|
| C1 | In transit | TLS to the database is required and verified at startup (`src/web/db_ssl.ts`); the load balancer terminates TLS for clients. |
| C2 | At rest | AWS KMS-managed encryption on RDS and S3, defined in Terraform. |
| C3 | Application-level encryption | A `DATA_ENCRYPTION_KEY` is required in production and its absence is a blocking startup readiness failure. |
| C4 | Key rotation | KMS-managed. Rotation procedure documented in `compliance/technical_standards/`; **rotation has not been exercised in a production deployment.** |

## D. Audit and evidence

| # | Question | Answer |
|---|---|---|
| D1 | Is there an audit log? | Yes, and it is append-only *at the database level*: UPDATE and DELETE are rejected by trigger for every role including the application's. Attempted mutation raises `audit_log is append-only`. |
| D2 | What is logged? | Administrative actions, configuration changes, case actions, invoice lifecycle, evidence exports, go-live decisions — with actor, entity and timestamp. |
| D3 | Can a customer obtain their own audit trail? | Yes. `GET /api/admin/clients/:id/evidence-pack` returns the ledger, invoices, configuration in force, go-live decisions and audit trail for a period, under a SHA-256 the recipient can recompute to confirm the copy is unaltered. |
| D4 | Is that hash a signature? | **No.** There is no signing key. It detects alteration of a copy; it does not prove origin. The pack states this itself. |
| D5 | Billing record integrity | Billable facts are written once to an append-only ledger (`usage_event`) — only the invoice that claimed a row may ever change, enforced by trigger. An issued invoice cannot be altered or deleted; corrections are a void and reissue. |

## E. Availability and recovery

| # | Question | Answer |
|---|---|---|
| E1 | Uptime commitment | See `service_level_agreement.md`. **The stated target has not been measured against a production deployment.** |
| E2 | Backups | RDS automated backups with point-in-time recovery, configured in Terraform. |
| E3 | Has restore been tested? | **No.** `docs/OPERATIONAL_RESILIENCE_RUNBOOK.md` defines the exercise; it has not been performed. Required external gate 7 in `docs/PRODUCTION_READINESS.md`. |
| E4 | RPO / RTO | Targets stated in the resilience runbook; **not yet measured**. |
| E5 | Multi-region | No. Single region. |

## F. Secure development

| # | Question | Answer |
|---|---|---|
| F1 | Code review | All changes land through pull request with CI required. |
| F2 | Static analysis | CodeQL on every pull request and on the default branch. |
| F3 | Dependency management | `npm audit --omit=dev --audit-level=high` is a required CI gate; a CycloneDX SBOM is generated and retained per commit. Production runtime dependencies are deliberately minimal. |
| F4 | Automated testing | 262 unit, 235 integration (against a real PostgreSQL) and 6 non-superuser RLS regression tests, all required to pass in CI. |
| F5 | Penetration testing | **Not performed.** |
| F6 | Secrets handling | Injected from AWS Secrets Manager; startup refuses to run in production without the required secrets present. |

## G. Subprocessors

| Subprocessor | Purpose | PHI exposure |
|---|---|---|
| Amazon Web Services | Hosting, storage, database, key management | Yes — covered by AWS's BAA |
| `[SMTP provider]` | Notification email | Notification metadata only; **must be BAA-covered before enabling** |
| `[Clearinghouse]` | Claim and appeal transmission | Yes — **not yet contracted or certified** |

The vendor register in `compliance/` is the maintained source; this table is the
customer-facing summary and must be reconciled against it before sending.

## H. Data handling

| # | Question | Answer |
|---|---|---|
| H1 | Retention | Defined in `compliance/technical_standards/` retention schedule. |
| H2 | Deletion on termination | Documented termination procedure. Note that the audit log and billing ledger are append-only by design and are retained per the retention schedule rather than deleted on request — a customer should understand this before signing. |
| H3 | Data export | Evidence pack (JSON) and per-invoice statements (HTML). Bulk claim-level export is available through the administrative API. |
| H4 | Is customer data used to train models? | No. There is no model training in this system. |
| H5 | Is data commingled? | Logically separated by row-level security in a shared database, not physically separated per customer. A reviewer should treat this as the key isolation control and may wish to test B2 and B3 independently. |

---

## Summary for a reviewer in a hurry

**Strong:** database-enforced tenant isolation proven under the real
non-superuser role; append-only audit and billing records enforced by triggers
rather than convention; minimal dependency surface with automated gating;
customer-verifiable evidence export.

**Absent:** every form of third-party assurance — no SOC 2, no penetration test,
no tested disaster recovery, no production clearinghouse certification. Single
region.

**Recommended posture for a first engagement:** shadow mode against real
remittances with no transmission and no fees, which is a supported operating
state of the product rather than a special arrangement.
