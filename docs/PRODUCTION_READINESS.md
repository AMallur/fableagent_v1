# Production readiness and release gates

The repository is designed to fail closed when an external delivery service is
not configured. A packet is not marked submitted merely because a connector
attempt was recorded, and console-only email output is not marked delivered.

## Automated release gates

- Unit tests and the full PostgreSQL integration suite pass.
- The dedicated RLS suite passes using a non-superuser runtime login.
- Migrations and their `schema_migrations` records commit atomically.
- The runtime Docker image builds successfully.
- `npm audit --omit=dev --audit-level=high` reports no high or critical issue.
- CodeQL completes successfully.

## Required external gates

These cannot be supplied by source code and must be completed for each live
customer and trading partner:

1. Execute BAAs with the hosting, storage, email and relevant integration
   providers before processing PHI.
2. Configure a durable GCS or S3 bucket with versioning, retention, access
   logging, least-privilege IAM/KMS and tested restore procedures.
3. Configure SMTP through a BAA-covered provider and verify delivery,
   suppression, bounce and alert escalation behavior.
4. Implement and certify the selected clearinghouse/payer connector. It must
   honor the packet `idempotencyKey`, return a real tracking reference and
   reconcile acknowledgements before autonomous delivery is enabled.
5. Validate each supported payer contract model against adjudicated examples.
   Unsupported contract constructs remain manual-review cases.
6. Require certified coding review for every corrected claim and modifier
   change. The rules engine is decision support, not clinical documentation.
7. Run load, failover, backup/restore and disaster-recovery exercises in the
   target infrastructure.
8. Complete the organizational HIPAA risk analysis, policies, workforce
   training, incident response plan and access-review process. Drafts of
   all of these live in `compliance/` — see `compliance/README.md` for what
   still needs to be filled in, signed, and (for the BAA template)
   attorney-reviewed before they're adopted rather than draft documents.
9. If lookup-owner roles are provisioned by a separate database administrator,
   grant their migration membership with `INHERIT FALSE` and revoke it after
   migrations. The runtime login must not remain a member of
   `rcm_pretenant_lookup` or `rcm_catalog_lookup`.
10. Import current CMS/X12 reference data through the canonical, checksummed
    importer; configure the CMS locality explicitly for percent-of-Medicare
    contracts and obtain required CPT/content licenses.
11. Validate AWS account-level controls (BAA, CloudTrail, Config/Security Hub,
    GuardDuty, central alarm routing and Terraform state protection). The
    application stack cannot establish those organizational controls itself.

## Supported initial production scope

The safest initial deployment is a de-identified or BAA-covered shadow-mode
pilot using structurally validated 835, 837P and explicitly activated contract rules. Operators
review findings and manually confirm external submissions. Institutional 837I,
dental claims, arbitrary payer companion guides and complex contract constructs
must not be represented as supported until their parsers, validation rules and
reconciliation tests are added.
