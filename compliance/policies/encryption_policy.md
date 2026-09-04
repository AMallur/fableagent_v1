# Encryption and Transmission Security Policy

**Citations:** 45 CFR §164.312(a)(2)(iv) (encryption/decryption), §164.312(e)
(transmission security). Both implementation specifications are
**Addressable**, not Required — meaning the Company must assess whether they
are reasonable and appropriate and, if not adopted as specified, document an
equivalent alternative measure or a documented rationale for not applying
them; this policy's choice to implement both as mandatory (§1.1, §1.2 below)
is the Company's own stricter-than-minimum decision, not itself a regulatory
requirement.
**Verified against:** [eCFR §164.312](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312) (2026).

**Owner:** HIPAA Security Officer. **Review cycle:** annually or after any
infrastructure change affecting encryption.

## 1. Policy

1. **Encryption at rest is mandatory** for every datastore that holds or can
   hold ePHI:
   - PostgreSQL/RDS: `storage_encrypted = true` with a customer-managed KMS
     key (`aws_kms_key.phi`), never the AWS-managed default key, so key
     policy and rotation are under the Company's control
     (`infra/aws/terraform/main.tf`).
   - S3 document storage: bucket policy denies any `PutObject` that does not
     specify `aws:kms` server-side encryption
     (`aws_s3_bucket_policy.documents`).
   - Secrets Manager: encrypted with the customer-managed key(s) referenced
     by `secret_kms_key_arns`.
   - RDS automated backups and snapshots inherit the instance's encryption.
2. **Encryption in transit is mandatory:**
   - `rds.force_ssl = 1` at the database parameter-group level; the
     application connects with `PGSSLMODE=verify-full`.
   - The ALB terminates TLS only (`ELBSecurityPolicy-TLS13-1-2-2021-06`,
     TLS 1.2 minimum); the HTTP listener exists only to redirect to HTTPS.
   - Clearinghouse (Optum) API calls are HTTPS-only, using cached OAuth2
     bearer tokens, never long-lived credentials in the request.
   - Any future SMTP integration must use a TLS-enforcing, BAA-covered
     provider before it is enabled.
3. **Key management.** The PHI KMS key has rotation enabled
   (`enable_key_rotation = true`). Key deletion requires the AWS-enforced
   30-day waiting window, preventing accidental irreversible loss.
4. **No plaintext ePHI outside the datastores above.** ePHI must not be
   written to local developer machines, personal cloud storage, chat tools,
   or email as a matter of course. Where a client sends historical claims
   data for onboarding/validation purposes, it is uploaded directly to the
   Company's encrypted storage and not routed through unencrypted channels.
5. **Logs are not a datastore for ePHI.** Application logging uses the
   redaction helpers in `engine/src/security/logging.ts`, which redact
   patient/member/X12/secret fields by an allowlist model (a field must be
   explicitly known-safe to pass through, not explicitly blocked) before
   anything reaches CloudWatch or job-status records. This is a technical
   control, not just a policy statement, and is covered by automated tests.

## 2. Verification

The AWS Config rules deployed in `infra/aws/terraform/security.tf`
(`rds_encrypted`, `s3_encrypted`, and related checks) continuously verify
encryption-at-rest configuration and alert on drift.
