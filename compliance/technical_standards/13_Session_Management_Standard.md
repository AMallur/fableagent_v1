# Session-Management Standard

*Authentication session issuance, renewal, expiration and revocation*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-SES-013 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose

Protect authenticated application sessions against theft, replay, excessive duration and continued use after access changes.

## Scope

Browser sessions, SSO-issued sessions, API keys, administrative interfaces and future mobile clients.

## Requirements

- Cookies must be HMAC-signed, HttpOnly, SameSite appropriate to the workflow, and Secure in production.
- Adopted inactivity timeout is 30 minutes unless a stricter customer setting applies; absolute maximum session lifetime must be configured and documented.
- Session claims must be revalidated so deactivation and role changes take effect promptly.
- Authentication, MFA, timeout, revocation and anomalous session events must be logged.
- API keys are not browser sessions and require independent scope, rotation, rate limit and revocation controls.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Configure tenant timeout and production cookie/TLS settings.
- Test login, renewal, idle timeout, absolute expiration, role change, deactivation and logout.
- Verify cookies contain no PHI and cannot be accepted after tampering.
- Review active key/session-related events and rotate secrets after compromise.
- Retain configuration and test evidence.

## Required evidence

- Production HTTP/cookie configuration.
- Session security test results.
- Tenant timeout export.
- Session-secret rotation record.
- API-key inventory and review.

## Current FableAgent implementation references

- engine/src/web/auth.ts uses signed expiring session payloads and refreshSession revalidation.
- README.md states configurable default 30-minute sliding timeout and FORCE_HTTPS/HSTS/Secure cookies.
- Production deployment evidence and an explicit absolute lifetime require confirmation.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
