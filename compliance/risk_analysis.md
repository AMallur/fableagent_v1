# HIPAA Security Risk Analysis

**Citation:** 45 CFR §164.308(a)(1)(ii)(A) — "Conduct an accurate and
thorough assessment of the potential risks and vulnerabilities to the
confidentiality, integrity, and availability of electronic protected health
information held by the covered entity or business associate."

**Prepared by:** [YOUR NAME], HIPAA Security Officer
**Date of this assessment:** [DATE]
**Review cycle:** at minimum annually, and after any material architecture,
vendor, or infrastructure change. Track revisions in the changelog at the
bottom of this document.

**Methodology:** This assessment follows the structure of the HHS Office for
Civil Rights' Security Risk Assessment (SRA) Tool methodology: identify where
ePHI is created, received, maintained, or transmitted; identify reasonably
anticipated threats and vulnerabilities against each; document current
controls; and rate likelihood x impact to produce a residual risk level and
remediation plan.

---

## 1. Scope: where ePHI lives in this system

FableAgent is a multi-tenant healthcare revenue-cycle-management (RCM)
platform. ePHI enters, is processed by, and is stored in the following
components (see `docs/PRODUCTION_READINESS.md` and `infra/aws/README.md`
for the corresponding technical detail):

| # | Asset | ePHI present | Location |
|---|---|---|---|
| A1 | PostgreSQL database (`patient`, `encounter`, `claim`, `claim_line`, remittance tables) | Yes — patient demographics, member IDs, diagnosis/procedure codes, billed/paid amounts | AWS RDS (encrypted at rest, KMS), private subnet |
| A2 | Raw X12 835/837 files (inbound remittances/claims) and generated appeal packet documents | Yes — full X12 payload, PHI in narrative appeal text | AWS S3 documents bucket (SSE-KMS), private via IAM |
| A3 | Application/scheduler compute (ECS Fargate tasks) | Transient — processes ePHI in memory during ingestion, detection, appeal generation | AWS ECS, private subnets, no public IP |
| A4 | Clearinghouse integration (Optum/Change Healthcare) | Yes — claim submission and status-check payloads contain patient/member/provider PHI | TLS to Optum API, OAuth2 client-credentials |
| A5 | Application/CloudWatch logs | Should not — PHI-safe redaction is enforced (`engine/src/security/logging.ts`) before anything reaches logs | AWS CloudWatch Logs |
| A6 | Backups / RDS snapshots | Yes — same content as A1 | AWS RDS automated backups, KMS-encrypted |
| A7 | Secrets (DB password, session secret, data-encryption key, SMTP, Optum credentials) | No PHI directly, but compromise enables access to A1/A2/A4 | AWS Secrets Manager, KMS-encrypted |
| A8 | Developer/operator workstations and GitHub repository | Should not — no PHI is checked into source control; seed/test data is synthetic | N/A (process control, not infrastructure) |
| A9 | SFTP claims-drop ingestion (self-hosted/EC2 pilot mode only, not the default ECS path) | Yes | Single EC2 host, `docker-compose.aws.yml` — explicitly a bounded pilot posture, see `infra/aws/README.md` "Deliberate pilot boundaries" |

## 2. Reasonably anticipated threats and current controls

### 2.1 Unauthorized access to ePHI (external)

**Threat:** An external attacker gains access to the database, document
store, or clearinghouse credentials.

**Current controls:**
- Multi-tenant PostgreSQL row-level security (RLS) enforced for every
  runtime login (`rcm_runtime`, `rcm_app`, `rcm_service` — see
  `db/migrations/`); the runtime role is never a superuser and cannot bypass
  tenant scoping.
- RDS is not publicly accessible; reachable only from the ECS task security
  group within the private subnet (`infra/aws/terraform/main.tf`).
- Storage encrypted at rest with a customer-managed KMS key
  (`aws_kms_key.phi`); S3 bucket policy denies unencrypted uploads and
  non-TLS transport.
- Account-level detective controls: CloudTrail (multi-region, S3 data
  events on the documents bucket), AWS Config, GuardDuty, Security Hub
  (`infra/aws/terraform/security.tf`).
- Optional AWS WAF with AWS-managed rule groups and per-IP rate limiting in
  front of the ALB (`infra/aws/terraform/hardening.tf`, `enable_edge_waf`).
- Secrets (DB password, session secret, data-encryption key, Optum
  credentials) held in Secrets Manager, never in source control or plain
  environment files; task execution role scoped to only the specific secret
  ARNs it needs (`aws_iam_role_policy.execution_secrets`).

**Residual risk: Medium.** No penetration test has been run against a live
deployment yet (nothing is currently deployed — see §5). WAF and private
interface VPC endpoints are implemented in Terraform but optional/off by
default pending a decision on when to pay for them.

### 2.2 Unauthorized access to ePHI (internal / workforce)

**Threat:** A workforce member (currently: the founder) with legitimate
system access misuses or accidentally exposes ePHI.

**Current controls:**
- Workforce is currently one person; access to production systems requires
  AWS account credentials and database credentials that are not shared.
- Application-level RBAC and tenant scoping exist in the web/API layer
  (`engine/src/web/`), so even authenticated application users only see
  their own tenant's data.
- PHI-safe structured logging (`engine/src/security/logging.ts`) redacts
  patient/member/X12/secret fields by default (allowlist model — a field
  must be explicitly allowlisted as safe, not explicitly blocked) before
  anything reaches CloudWatch or `system_job.log_output`.

**Residual risk: Low**, given current single-person workforce; **re-assess
before hiring** — access provisioning/de-provisioning and least-privilege
role assignment are not yet formalized beyond the AWS IAM policies already
in Terraform.

### 2.3 Data loss / availability failure

**Threat:** Database corruption, accidental deletion, or an AWS regional
outage causes loss of ePHI or a service outage.

**Current controls:**
- RDS automated backups (14-day retention), Multi-AZ, encrypted storage,
  deletion protection enabled by default (`var.deletion_protection`).
- S3 document bucket versioning enabled; lifecycle policy retains
  noncurrent versions.
- CloudWatch alarms on DB CPU, free storage, freeable memory, and ALB
  5xx/latency/unhealthy-target metrics (`infra/aws/terraform/main.tf`,
  `hardening.tf`).

**Residual risk: Medium** — no disaster-recovery or backup-restore exercise
has actually been performed yet (tracked as an open gate in
`docs/PRODUCTION_READINESS.md`, item 7). A Terraform definition existing is
not the same as a tested restore.

### 2.4 Transmission security

**Threat:** ePHI is intercepted or altered in transit (patient portal,
clearinghouse submission, SMTP).

**Current controls:**
- TLS enforced end-to-end: ALB HTTPS listener with TLS 1.2+ policy
  (`ELBSecurityPolicy-TLS13-1-2-2021-06`), HTTP→HTTPS redirect,
  `rds.force_ssl=1` parameter group setting, `PGSSLMODE=verify-full` on the
  application's DB connection.
- Clearinghouse (Optum) calls are OAuth2 client-credentials over TLS,
  cached token with safety margin (`engine/src/integration/optum_client.ts`).
- SMTP is explicitly disabled by default until a BAA-covered provider is
  configured (`docs/PRODUCTION_READINESS.md` gate 3) — not yet in place.

**Residual risk: Low** for implemented paths; **email delivery is an open
item** — do not enable it until a BAA-covered SMTP provider is under
contract.

### 2.5 Improper disposal / retention

**Threat:** ePHI retained longer than necessary, or not securely destroyed
when a tenant/client offboards.

**Current controls:** S3 lifecycle rules exist for noncurrent-version
expiration; audit logs retained 2555 days (7 years) as a common healthcare
floor (explicitly flagged as not yet confirmed against the Company's actual
retention policy — see comment in `infra/aws/terraform/security.tf`).

**Residual risk: Medium** — no formal data-retention/destruction policy has
been written yet for client offboarding. **Open item**, not yet a written
policy; add before onboarding a first real client.

### 2.6 Third-party / subprocessor risk

**Threat:** A vendor (AWS, Optum, SMTP provider) mishandles ePHI shared with
them, or their own breach exposes the Company's clients' data.

**Current controls:**
- AWS BAA acceptance is in progress per the user's own confirmation.
- Optum/Change Healthcare is a HIPAA-regulated clearinghouse; a trading
  partner agreement with them is a prerequisite for production access
  (tracked in `docs/PRODUCTION_READINESS.md` gate 4 and
  `docs/aws_deployment` funding/onboarding notes).
- No subprocessor is used without a BAA — this is a stated policy
  (`compliance/policies/vendor_baa_management_policy.md`) but enforcement is
  currently manual, not automated.

**Residual risk: Medium** pending the AWS BAA fully executed, Optum
production trading-partner agreement, and no SMTP provider yet selected.

### 2.7 Payer/capability activation misconfiguration

**Threat:** A client's claims are submitted, or detection/appeal automation
runs, against a payer relationship that has not actually been validated —
producing incorrect submissions or PHI sent to the wrong destination.

**Current controls:** The client × payer implementation state machine
(`draft → validation_pending → validated → active`, PR #10) fail-closed
gates detection, appeal generation, and electronic submission independently
per payer capability, requiring recorded validation evidence before
activation. A payer cannot go directly from draft to production.

**Residual risk: Low** — this is a genuine software control, not just a
policy statement, and is exercised by the integration test suite.

## 3. Summary risk register

| Threat area | Residual risk | Primary open item |
|---|---|---|
| External unauthorized access | Medium | No live penetration test; WAF/interface endpoints optional |
| Internal/workforce access | Low (re-assess at first hire) | No formal access-review cadence yet |
| Data loss / availability | Medium | No DR/restore exercise performed |
| Transmission security | Low (SMTP: not applicable yet) | SMTP provider not yet selected/BAA'd |
| Improper disposal/retention | Medium | No written retention/destruction policy yet |
| Third-party/subprocessor | Medium | AWS BAA in progress; Optum production TPA not yet executed |
| Payer activation misconfiguration | Low | N/A — enforced in code |

## 4. Remediation plan

| Item | Owner | Target |
|---|---|---|
| Complete AWS BAA execution | Security Officer | Before any live PHI in AWS |
| Execute Optum/Change Healthcare production trading-partner agreement | Security Officer | Before first live claim submission |
| Select and BAA a transactional email provider before enabling SMTP | Security Officer | Before enabling `smtp_secret_arn` |
| Run one backup-restore exercise against a non-production RDS instance | Security Officer | Before first live client go-live |
| Write a data-retention/destruction policy covering client offboarding | Security Officer | Before first live client go-live |
| Formalize access review cadence (quarterly) once workforce > 1 person | Security Officer | At first hire |
| Decide on and budget for `enable_edge_waf` / `enable_interface_endpoints` before exposing a production endpoint | Security Officer | Before `deploy_paid_infrastructure = true` for a real client |

## 5. Current deployment status (context for this assessment)

As of this assessment, **no AWS infrastructure from this Terraform
configuration has been applied to a live account** — `deploy_paid_infrastructure`
and `services_enabled` are both `false` by design (see
`infra/aws/terraform/variables.tf`). This risk analysis assesses the
system as designed and as it will be deployed, not an environment currently
processing live PHI. Re-review this document at the point of first live
deployment and again at the point of onboarding the first real client.

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| [DATE] | [YOUR NAME] | Initial risk analysis |
