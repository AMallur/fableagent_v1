# Operational resilience and recovery runbook

This runbook turns backup, restore, failover, load, and dependency-outage requirements into repeatable acceptance exercises. It must be executed against the actual target environment before a live customer relies on those controls.

Do not copy example outcomes into a security questionnaire. Record measured results from the deployment being evaluated.

## 1. Declare targets before testing

For each environment record:

- service owner;
- cloud/account/region;
- database service and backup mechanism;
- object/document storage service;
- release commit and image digest;
- recovery point objective (RPO);
- recovery time objective (RTO);
- maximum acceptable scheduled-job delay;
- maximum acceptable API/web error rate under normal load;
- expected peak claim/remittance volume; and
- incident escalation contacts.

RPO/RTO are contractual/operational targets chosen by the operator and customer. The repository does not assign them automatically.

## 2. Evidence required for every exercise

Capture:

1. exercise ID, date, operator and approver;
2. exact release/image/infrastructure version;
3. test start and end timestamps;
4. injected failure or restore point;
5. screenshots/log excerpts or machine outputs sufficient to reproduce the result;
6. measured recovery time and data-loss window;
7. control totals before and after;
8. failed checks and remediation tickets; and
9. final pass/fail decision against the predeclared acceptance criteria.

Store the artifacts in a versioned evidence bundle and generate a SHA-256 manifest with `npm run evidence:manifest`.

## 3. Backup and database restore exercise

Perform at least once before first live use and on the cadence required by policy/customer agreement.

1. Select a documented backup/recovery point without modifying it.
2. Restore into an isolated recovery environment, never over the live database.
3. Record backup timestamp, restore start, database-ready time and application-ready time.
4. Run migrations only if the recovery procedure explicitly requires them; record every migration version.
5. Compare control totals for tenants, clients, claims, remittances, cases, documents, audit records and system jobs.
6. Run the normal unit/integration smoke set appropriate for the restored environment.
7. Run non-superuser tenant-isolation checks against the restored database.
8. Verify the application health endpoint and representative authenticated workflows.
9. Verify that audit records are present through the declared RPO boundary.
10. Document any rows/artifacts newer than the recovery point that are expected to be absent.

Pass only when measured data loss is within the declared RPO, service restoration is within the declared RTO, control totals reconcile, and isolation/security checks pass.

## 4. Application/process interruption exercise

Test an interruption while work is in progress.

1. Start representative ingestion/detection work using non-production or approved test data.
2. Terminate the application or scheduler process at a documented point.
3. Restart the process using the same release.
4. Verify `system_job` state accurately reflects the interrupted execution.
5. Re-run the work and confirm idempotency: no duplicate remittances, claims, cases, packets, payment events, or outbound actions.
6. Verify alerts/logs identify the interruption.

Any duplicate economic action, silent partial completion, or untraceable job state is a release blocker until remediated.

## 5. Database outage exercise

1. Make database connectivity unavailable in the test environment.
2. Confirm `/healthz` returns unhealthy and the orchestrator/load balancer reacts as designed.
3. Confirm requests fail without returning stale or cross-tenant data.
4. Restore connectivity.
5. Confirm pooled connections recover without retaining another tenant's context.
6. Run tenant-isolation and representative workflow checks after recovery.

## 6. Object/document storage outage exercise

For the production document-store adapter:

1. Deny or interrupt storage access.
2. Attempt a workflow that requires a document read/write.
3. Confirm failure is explicit and does not mark a packet/document as successfully persisted when it was not.
4. Restore access and retry.
5. Verify object integrity, metadata linkage, and audit trail.

## 7. Email/notification outage exercise

1. Disable the configured email transport or route it to a controlled failing endpoint.
2. Generate representative notification work.
3. Confirm failed delivery is not recorded as delivered.
4. Confirm retry/escalation behavior follows the configured policy.
5. Restore transport and verify successful delivery and auditable state.

## 8. External connector outage/retry exercise

Before any connector can be enabled for autonomous delivery, its certified environment must demonstrate:

- stable idempotency keys;
- acknowledgement/tracking references;
- explicit rejection handling;
- timeout behavior;
- bounded retry/backoff;
- duplicate-send prevention;
- reconciliation after ambiguous network failures; and
- customer-visible/auditable final state.

A locally recorded connector attempt is not proof of external submission.

## 9. Load and saturation test

Use representative file sizes, request mixes, database sizes and scheduled workloads. PHI is not required for load testing.

Measure at increasing load:

- request throughput and latency percentiles;
- API error rate;
- database connection use and query latency;
- scheduler/job queue delay;
- ingestion throughput;
- memory/CPU utilization;
- document-store latency; and
- recovery after load is removed.

Stop the test before it threatens a production customer. Record the sustainable operating envelope and configure alerts below the observed saturation point with an appropriate margin.

## 10. Security-control recovery check

After any restore/failover verify:

- production secrets came from the intended secret source;
- HTTPS/TLS enforcement remains active;
- admin MFA policy remains enabled where required;
- RLS and application database roles are unchanged;
- audit protections remain active;
- API/SFTP credentials and revocation state are current; and
- logging/monitoring/alert routing is functioning.

A restored application that loses a security control has not successfully recovered.

## 11. Acceptance record

The accountable release owner signs the exercise record only when all required targets pass. Failed or partially completed exercises remain open risks in the commercial assurance matrix; they are not converted into "passed" controls by a runbook or planned remediation date.
