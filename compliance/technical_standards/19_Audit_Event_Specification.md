# Audit-Event Specification

*Security, PHI access and business-action event requirements*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-AUD-019 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Required event families

| Family | Events | Required fields and limits |
|---|---|---|
| Authentication | login success/failure/lockout, MFA enroll/failure, password change, SSO | User, tenant, time, IP, result; no password/secret |
| Authorization | denied action, privilege/role/scope change | Actor, target, old/new role, approver/ticket |
| PHI access | view, search, export, download, API PHI read | User/service, tenant/client, record type/id, purpose where captured, result |
| Data mutation | create/update/delete/restore | Actor, entity/id, permitted redacted change summary |
| Claims/appeals | ingest, detection, approval, submission, acknowledgment, reconciliation | Job/user, tenant/client, claim/case/packet id, status |
| Administration | tenant/client/user/integration/security configuration | Actor, target, before/after excluding secrets |
| System | job start/end/failure, backup/restore, scan, service failure | Service, version, environment, correlation id, result |
| Incident | alert, triage, containment, evidence access | Incident id, actor, time, decision, evidence reference |

## Purpose

Create reliable, attributable records sufficient to detect misuse, investigate events, support customers and demonstrate controls without unnecessarily duplicating PHI.

## Scope

Application, API, database, cloud, storage, identity, CI/deployment, SFTP, clearinghouse and administrative systems.

## Requirements

- Every event requires timestamp, environment, tenant where applicable, actor/service identity, action, target reference, result and correlation identifier.
- Logs must not include passwords, session tokens, MFA seeds, encryption keys, full X12 payloads, clinical narrative or unnecessary patient fields.
- Audit evidence must be access-controlled, time-synchronized, protected against unauthorized modification/deletion and reviewed according to risk.
- Event failure for security-critical actions must fail safely or alert immediately.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Map each required event to source system and owner.
- Implement structured events with approved redaction.
- Test success, failure, denied and administrative paths.
- Route to approved protected storage and create alerts.
- Review completeness and retention periodically.

## Required evidence

- Event catalog/schema.
- Sample synthetic events.
- Integrity/access configuration.
- Alert and review records.
- Retention/deletion evidence.

## Current FableAgent implementation references

- db/migrations/0007_audit_and_jobs.sql creates audit_log and system_job.
- README.md describes append-only audit and PHI access logging.
- engine/src/web/auth.ts emits authentication security events.
- GAP: generic before_state/after_state may contain excessive PHI and requires field review/redaction strategy.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
