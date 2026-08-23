# Security threat model

This is a living threat model for the FableAgent application and initial commercial shadow-pilot scope. It maps material threats to implemented controls, test evidence, and deployment evidence that still has to be collected. It is not a penetration-test report, HIPAA attestation, or SOC report.

## Protected assets

- claim/remittance and other regulated customer data;
- payer contract and reimbursement terms;
- user, API, SFTP and integration credentials;
- generated findings, case work, documents and submission records;
- audit and access logs;
- tenant/customer boundaries;
- external-validation evidence;
- deployment secrets and encryption keys.

## Trust boundaries

1. Browser/user to the web server.
2. API client to `/api/v1`.
3. SFTP client to the inbound drop service.
4. Application processes to PostgreSQL.
5. Application to document/object storage.
6. Application to SMTP/email provider.
7. Application to clearinghouse, payer portal, or downstream write-back connector.
8. CI/release system to the production deployment environment.

Every new external connector or data path requires this model to be updated before production enablement.

## Threat register

| Threat | Primary controls in repository | Automated evidence | Deployment/external evidence still required |
|---|---|---|---|
| Credential stuffing / password guessing | scrypt password storage; five-attempt lockout; admin MFA; security-event audit | `engine/test/security.test.ts` plus integration auth tests | IdP/customer policy review; alert routing; independent penetration test |
| Session forgery or stale privileges | HMAC-signed expiring cookies; timing-safe MAC comparison; server-side user/role refresh on requests; Secure cookie in HTTPS mode | auth/web integration tests | TLS/proxy configuration and cookie capture test in target environment |
| Missing production secrets | required secret loader refuses production startup without configured values; file-secret convention supported | runtime-readiness/security tests | target secret-manager IAM, rotation and access-log evidence |
| Cross-tenant data access | tenant context bound to request/database work; forced RLS; client scoping | non-superuser RLS suite; tenant-pool regression tests | independent authorization/tenant-escape penetration test |
| Pre-tenant login data leak | narrow tenant lookup then tenant context before user-row access | integration/RLS coverage | penetration test and database privilege review |
| Privilege escalation through SSO | signed SAML assertion validation; explicit group-to-role mapping; role sanitization | SSO/security tests | customer IdP configuration review and test assertions |
| API-key abuse | hashed/scoped keys; revocation; per-key rate limiting; API request logging | API integration tests | key rotation procedure; SIEM/alert verification |
| Oversized/malformed request denial of service | bounded JSON/upload body reads; structural input validation; API rate limits | web/API/ingest tests | load and saturation tests against target infrastructure |
| SFTP path traversal / cross-client file access | per-client credentials and confined upload-only behavior | real-client SFTP integration test | external network/SSH configuration review; penetration test |
| Claim/remittance replay or duplicate processing | idempotent ingestion identifiers; processed-file archival; job guards | ingest/pipeline integration tests | production replay exercise using customer-like files |
| Contract/reference tampering | explicit contract lifecycle/versioning; current reference importer; activation checks | contract/reference tests | customer contract-owner approval and source/license records |
| Audit-log deletion or alteration | append-only database enforcement; security/access events; request/job logs | migration/RLS/integration tests | retention, export, backup and administrator-access review |
| Evidence tampering after pilot publication | SHA-256 evidence manifests; immutable versioning rule | `engine/test/evidence_manifest.test.ts` | customer/custodian retention and signed publication record |
| Sensitive data leakage in logs | structured security logging with deliberate fields; PHI access trail | logging tests | production log sampling, retention/access review and SIEM configuration |
| Data disclosure at rest | application-level encryption for selected secrets; storage-level encryption requirement for data/document stores | crypto tests | database/disk/bucket KMS configuration and cloud evidence |
| Data disclosure in transit | HTTPS mandatory in production; SFTP/SSH for file drop | runtime/web tests | certificate/proxy scan; connector-specific TLS evidence |
| Unsafe autonomous outbound action | initial pilot requires manual approval; unconfigured connectors fail closed; review gates override automation | pipeline/connector tests | trading-partner certification and customer authorization before enablement |
| Incorrect recovery/coding action | unsupported/low-confidence paths require human review; corrected claims require qualified review in production gates | rule/appeal tests | real-data RCM validation and qualified coding signoff |
| Dependency compromise | locked npm dependencies; Dependabot; high/critical production audit gate; CodeQL | GitHub CI | release review and software-supply-chain policy as required by customer |
| CI/release artifact substitution | release identified by Git commit; Docker build gate; evidence manifest can bind supporting artifacts | GitHub Actions | image signing/provenance and registry policy in target deployment |
| Database loss/corruption | transactional persistence and migration controls | integration/migration tests | encrypted backups plus documented restore/failover exercise |
| Regional/service outage | health checks and deployable multi-service architecture | build/runtime tests | target RTO/RPO, failover and disaster-recovery exercise |

## High-risk release conditions

The following conditions are release blockers for a live customer unless the customer explicitly scopes them out:

- a known tenant-isolation failure;
- missing production secrets or encryption keys;
- failed high/critical dependency gate;
- required database migrations not applied atomically;
- missing BAA or required service agreement for a data-bearing provider;
- untested backup restoration for the target environment;
- autonomous outbound delivery without trading-partner acknowledgement/retry/reconciliation evidence;
- unsupported contract constructs being priced as if supported;
- external-validation claims without preserved reviewer/source evidence; or
- unresolved critical/high security findings without written risk acceptance by the accountable owner.

## Verification cadence

- Every pull request: unit/integration/RLS/security and dependency gates through CI.
- Every production release: re-run automated gates and bind the release commit/image to the release evidence packet.
- At least annually and after material architecture changes: independent penetration testing and threat-model review.
- After material cloud/network/storage changes: repeat environment security review, restore test and relevant failure exercises.
- Before each new live connector: update the trust-boundary analysis and obtain connector-specific certification evidence.

## Residual risk

Passing repository tests proves implementation properties only under the tested conditions. It does not prove that a customer's IdP, cloud account, network perimeter, object store, email provider, trading partner, workforce process, or operational response is correctly configured. Those controls remain deployment or external evidence in `COMMERCIAL_ASSURANCE_MATRIX.md`.
