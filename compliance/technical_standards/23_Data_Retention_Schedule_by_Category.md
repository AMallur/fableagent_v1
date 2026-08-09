# Data-Retention Schedule by Category

*Proposed FableAgent retention and disposal rules*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-RET-023 |
| Version | 0.1 — Draft for review |
| Owner | Privacy Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Retention schedule

| Category | Proposed retention | Basis | System |
|---|---|---|---|
| HIPAA policies/procedures and required documentation | 6 years from creation or last effective date, whichever later | HIPAA documentation rule | Restricted compliance repository |
| Risk analyses, control reviews and remediation evidence | At least 6 years | Compliance evidence | Restricted compliance repository |
| Training, sanctions and access reviews | At least 6 years unless counsel directs longer | Compliance evidence | Restricted compliance repository |
| BAAs and HIPAA-relevant contracts | Agreement term plus at least 6 years; apply longer legal-hold requirement | Contract/evidence | Contract repository |
| Claims, encounters, patients and remittances | Customer contract and approved records schedule; no unilateral deletion | Customer PHI | RDS for PostgreSQL |
| Appeal packets and uploaded documents | Customer contract and approved records schedule | Customer PHI | Private S3 |
| Audit/PHI access/security events | Proposed 6 years where used as HIPAA evidence; validate feasibility and contract | Security evidence; may contain PHI | Approved protected log store |
| Job/error telemetry | 30–90 days unless incident/evidence requires longer | Operational; PHI prohibited | Approved log store |
| Backups | Rolling schedule aligned to recovery and deletion obligations; initial design 14 DB backups | ePHI copy | RDS/S3 |
| Incident/breach records | At least 6 years; longer if litigation/contract requires | Compliance/legal | Restricted incident repository |
| Support tickets | Minimum necessary; purge per approved support schedule | PHI prohibited unless approved channel | Support system |
| CI/test artifacts | Per engineering schedule | Synthetic only | GitHub CI |
| AI prompts/outputs | Prohibited unless approved use specifies shortest necessary retention | Potential PHI | Approved AI service only |
| Customer termination export | Until confirmed delivery plus short controlled validation period | Customer PHI | Encrypted transfer staging |

## Purpose

Retain information only as long as required for customer service, legal obligations, security, recovery and documented business need, then securely dispose of it.

## Scope

Production data, documents, logs, backups, contracts, compliance evidence, support records and temporary exports.

## Requirements

- HIPAA does not establish one universal medical-record retention period for all PHI; customer contracts and applicable state/federal rules must be incorporated.
- Legal hold suspends deletion for identified records without silently changing unrelated retention.
- Deletion must include primary stores, replicas, caches, temporary exports and eventual backup expiration.
- Every category requires owner, system, trigger and verifiable disposal method.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Approve customer and legal retention requirements.
- Configure database/storage/log lifecycle and deletion jobs.
- Review scheduled deletion and exceptions.
- Verify deletion or backup aging and issue evidence.
- Review schedule after contract, law or architecture changes.

## Required evidence

- Approved schedule and customer-specific addenda.
- Lifecycle/job configuration.
- Deletion reports/certificates.
- Legal-hold register.
- Exception and review history.

## Current FableAgent implementation references

- RDS for PostgreSQL provision design retains 14 backups; business approval is required.
- Application uses soft deletion broadly; complete hard-delete/retention automation is not evidenced and remains a gap.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
