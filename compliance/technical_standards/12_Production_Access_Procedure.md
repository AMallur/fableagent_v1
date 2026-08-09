# Production-Access Procedure

*Request, approval, use, monitoring and removal of privileged production access*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-IAM-012 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose

Limit production and PHI access to authorized personnel for approved tasks and time periods.

## Scope

AWS account, database, containers/hosts, S3, logs, secrets, CI deployment, SFTP administration, clearinghouse credentials and compliance evidence.

## Requirements

- Default standing human access is read-only or absent; privileged changes use just-in-time or time-bounded access where available.
- Production access requires training, MFA, manager/System Owner approval and ticketed purpose.
- Shared accounts and direct production-data copies are prohibited.
- Emergency access must be documented retrospectively within one business day.
- All privileged actions must be attributable and reviewed.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Requester opens a ticket specifying system, role, customer scope, purpose, duration and data need.
- Manager and System Owner approve; Security approves privileged or emergency access.
- Administrator provisions the least privilege and confirms MFA.
- User performs the task, records commands/changes and avoids local PHI.
- Administrator removes time-bounded access and reviewer validates logs and outcome.

## Required evidence

- Access ticket and approvals.
- IAM change/audit logs.
- Privileged session or change record.
- Quarterly privileged-access review.
- Emergency access after-action review.

## Current FableAgent implementation references

- Application access is tenant/client scoped and revalidated against active user status.
- Cloud IAM/JIT workflow is not established in repository and requires production configuration.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
