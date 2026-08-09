# Secrets and Encryption-Key Management Procedure

*Generation, storage, use, rotation, recovery and destruction*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-KEY-014 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose

Protect credentials and cryptographic material that can expose PHI or weaken security controls.

## Scope

Session signing keys, DATA_ENCRYPTION_KEY, database credentials, SMTP credentials, SFTP host/client secrets, API keys, cloud service identities, TLS material and backup keys.

## Requirements

- Secrets must not be committed to source control, included in logs, tickets, chat, email or test fixtures.
- Production secrets must use an approved managed secret store or protected mounted file; plaintext environment variables are an interim deployment mechanism only when exposure is assessed and restricted.
- Keys require named owner, purpose, creation date, consumers, rotation schedule and revocation procedure.
- Rotation must support overlap or controlled cutover and be tested.
- Suspected disclosure triggers immediate incident response and credential rotation.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Inventory secrets and assign owners/classification.
- Generate using cryptographically secure tooling; never reuse demo/CI values.
- Store in approved secret manager and grant workload identity access only.
- Rotate on schedule, personnel/vendor changes and suspected compromise.
- Verify services use new values, revoke old values and record evidence.

## Required evidence

- Secret inventory without secret values.
- IAM and secret-version audit logs.
- Rotation and recovery test records.
- Source/secret scan results.
- Incident records for exposure.

## Current FableAgent implementation references

- .env.example supports SESSION_SECRET, DATA_ENCRYPTION_KEY and mounted-file variants.
- engine/src/security/secrets.ts resolves required production secrets and mounted files.
- engine/src/security/crypto.ts uses AES-256-GCM for selected integration/TOTP secrets.
- GAP: managed Secret Manager adoption and production rotation evidence are required.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
