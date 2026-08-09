# MFA Configuration Standard

*Authentication requirements for workforce and privileged access*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-IAM-009 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose

Establish strong, consistent multifactor authentication for every workforce identity with production or PHI access.

## Scope

Application users, cloud console, GitHub administrators, database administration, SFTP administration, identity provider, monitoring, compliance storage and emergency access.

## Requirements

- MFA is mandatory for all PHI-capable users before live production; administrative MFA alone is insufficient for this adopted standard.
- Prefer phishing-resistant WebAuthn/FIDO2 for cloud and administrative systems; TOTP is an acceptable interim application factor; SMS is not approved except documented break-glass recovery.
- Enrollment requires verified identity; recovery cannot rely solely on email; shared accounts are prohibited.
- Failed MFA, enrollment and recovery events must be logged and reviewed.
- Break-glass accounts must be few, vaulted, monitored and tested.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Inventory all in-scope identity providers and local accounts.
- Enable MFA for every eligible user and enforce through policy, not voluntary enrollment.
- Test normal login, failed factor, recovery, deactivation and break-glass paths.
- Export configuration and enrollment evidence.
- Review enrollment and exceptions at least quarterly.

## Required evidence

- Identity-provider policy export.
- Application tenant enforce_mfa configuration.
- User MFA enrollment report.
- Recovery and break-glass test.
- Quarterly access review.

## Current FableAgent implementation references

- engine/src/web/auth.ts enforces TOTP for ADMIN_ROLES when tenant.enforce_mfa is enabled.
- engine/src/security/crypto.ts encrypts TOTP secrets with AES-256-GCM.
- README.md states real tenants default to enforce_mfa=true; demo disables it.
- GAP: current application code limits MFA enforcement to super_admin, tenant_admin and client_admin.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
