# PHI-Safe Logging Standard

*Permitted telemetry, prohibited data and redaction requirements*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-LOG-020 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Logging classification

| Permitted by default | Prohibited unless specifically designed/approved |
|---|---|
| Correlation IDs; tenant/client IDs where protected; internal record IDs; status; duration; counts; error class; service/version; redacted payer/transaction metadata | Names, addresses, DOB, SSN, MRN, member IDs, diagnoses, procedures tied to a person, full claim/835/837 payloads, clinical notes, appeal text, credentials, tokens, keys, cookies |

## Purpose

Minimize PHI in operational logs while retaining sufficient security and reliability evidence.

## Scope

Application stdout/stderr, job logs, audit events, cloud logs, SMTP logs, CI logs, error files, support tickets, alerts and analytics.

## Requirements

- Logs are not a secondary PHI database and must use identifiers/references rather than content whenever possible.
- Secrets and authentication material are always prohibited.
- Errors returned to users must not expose database, tenant, file path or PHI details.
- If PHI is unavoidable, the log system enters the HIPAA boundary, requires BAA/service approval, access controls, retention and incident coverage.
- Debug logging against live PHI requires approved time-bounded change and post-use deletion.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Inventory every log sink and field.
- Classify each field and remove/redact prohibited values.
- Create automated tests using synthetic sensitive markers.
- Configure retention, access and alerts in approved service.
- Review samples after releases and incidents.

## Required evidence

- Logging field inventory.
- Redaction tests.
- Sink configuration and BAA/service approval.
- Access/retention review.
- Synthetic log sample.

## Current FableAgent implementation references

- system_job.log_output and SFTP error logs require review for exception-message PHI.
- audit_log before_state/after_state require minimization assessment.
- CI is synthetic-only and must not receive production payloads.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
