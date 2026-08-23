# Production readiness and release gates

The repository is designed to fail closed when an external delivery service is
not configured. A packet is not marked submitted merely because a connector
attempt was recorded, and console-only email output is not marked delivered.

## Automated release gates

- Unit tests and the full PostgreSQL integration suite pass.
- The dedicated RLS suite passes using a non-superuser runtime login.
- Migrations and their `schema_migrations` records commit atomically.
- Every ingested 835 satisfies the X12 balancing rules (service line, claim,
  and check totals including provider-level adjustments) under the client's
  configured policy. `strict` is the default and rejects a file that does not.
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
5b. Configure the pricing terms before invoicing anyone: `pricing_plan` is the
   only thing that decides what is billed, and a client with no plan on file
   invoices nothing. Set `payer.payment_reduction_percent` to 2.000 on Medicare
   and Medicare Advantage payers, and confirm `contract.apply_lesser_of_billed`
   matches each signed contract — left wrong, the first two produce a
   `systemic_underpayment` anomaly against payers that are paying correctly,
   and the third fabricates variance from the provider's own charge master.
5a. Agree the recovery-attribution basis in writing with the customer before
   any fee is charged against recovered dollars. The reconciler attributes
   line-scoped, post-appeal cash net of reversals and PLB recoupments, records
   every component on `payment_event`, and never reverses a recovery a person
   matched by hand. That is a defensible basis, not a substitute for the
   customer having agreed to it.
6. Require certified coding review for every corrected claim and modifier
   change. The rules engine is decision support, not clinical documentation.
7. Run load, failover, backup/restore and disaster-recovery exercises in the
   target infrastructure.
8. Complete the organizational HIPAA risk analysis, policies, workforce
   training, incident response plan and access-review process. Drafts of
   all of these — plus a deeper technical/operational layer (tenant
   isolation, secrets management, audit events, AI/LLM PHI-use
   restrictions, and more) in `compliance/technical_standards/` — live in
   `compliance/` — see `compliance/README.md` for what still needs to be
   filled in, signed, and (for the BAA template) attorney-reviewed before
   they're adopted rather than draft documents.
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
