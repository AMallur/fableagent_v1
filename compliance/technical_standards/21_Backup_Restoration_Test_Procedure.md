# Backup Restoration Test Procedure

*Evidence-based verification that ePHI can be recovered*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-BCP-021 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Proposed recovery objectives

| System | Proposed RPO | Proposed RTO | Approval/status |
|---|---|---|---|
| RDS for PostgreSQL claims/remittances/audit | ≤ 15 minutes where PITR supports | ≤ 4 hours | Customer/business approval required |
| S3 documents | ≤ 24 hours; versioning protects overwrite | ≤ 8 hours | Bucket lifecycle/restore validation required |
| Configuration/secrets | At every approved change | ≤ 4 hours | Recovery method must not expose secret values |
| Application image/source | Each release | ≤ 2 hours | Immutable image/build and rollback evidence required |

## Purpose

Verify through testing—not assumption—that FableAgent can restore data and services within approved recovery objectives while preserving confidentiality, integrity and tenant isolation.

## Scope

RDS for PostgreSQL, S3 documents, configuration, secrets, application artifacts and required audit evidence.

## Requirements

- Restoration tests use synthetic or authorized isolated data and a non-production recovery target.
- The tester must validate record counts, checksums/samples, permissions, RLS, encryption, timestamps and application function.
- Backup success notifications alone do not constitute restoration testing.
- Failures create high-priority remediation and retest.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Approve test scope, RPO/RTO and recovery point.
- Create isolated recovery environment and authorize personnel.
- Restore database, documents and necessary configuration.
- Validate integrity, isolation, access, application function and elapsed time.
- Securely destroy temporary restored data.
- Complete report, remediate failures and obtain approval.

## Required evidence

- Backup configuration and successful job evidence.
- Completed restoration worksheet with timestamps.
- Integrity/RLS/application test results.
- Temporary-environment deletion evidence.
- Remediation and retest record.

## Current FableAgent implementation references

- infra/aws/terraform/main.tf configures RDS Multi-AZ, 14-day automated backup retention, and encrypted storage (`aws_db_instance.postgres`) — provisioning only; no restore has been tested.
- infra/aws/terraform/main.tf also configures S3 bucket hardening for documents (versioning, KMS encryption, public-access block, lifecycle) — this part is implemented, not external; the restore/recovery test itself is what's outstanding.
- docs/PRODUCTION_READINESS.md requires backup/restore and DR exercises (gate 7) — still unperformed as of this writing.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
