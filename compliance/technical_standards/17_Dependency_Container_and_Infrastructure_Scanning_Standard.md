# Dependency, Container and Infrastructure Scanning Standard

*Required security scanning and remediation thresholds*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-VUL-017 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Required scan set

| Scan | Frequency | Release threshold | Current position |
|---|---|---|---|
| Dependency/SCA | Each PR/build and scheduled | No unresolved high/critical unless approved exception | npm audit gate present |
| SAST | Each PR/build and scheduled | No critical; high requires review and treatment | CodeQL present |
| Secret scanning | Pre-commit/PR and continuous | Any verified secret blocks/revokes | Repository setting/evidence required |
| Container image | Each image build | No unapproved high/critical | Image builds; vulnerability scan required |
| IaC/configuration | Each infrastructure change | No critical public exposure or encryption/IAM failure | Required |
| Cloud configuration | Continuous/daily where available | Alert on IAM, logging, backup, public access drift | Required |
| DAST/API | Before major release and periodically | Critical/high treated before production | Required |

## Purpose

Detect vulnerable components, insecure code, secrets and cloud misconfiguration before and after release.

## Scope

Application dependencies, source, Docker images, infrastructure/configuration, APIs and cloud resources.

## Requirements

- Findings require owner, severity validation, target remediation date, compensating controls and closure evidence.
- Critical actively exploitable findings require immediate containment; high findings normally block release.
- False positives require documented technical justification and expiration.
- Scan tools and signatures must be maintained.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Run required scans automatically and on demand after major advisories.
- Triage for exploitability and PHI impact.
- Create remediation ticket and link affected version/assets.
- Fix or apply approved time-limited mitigation.
- Rescan and document closure; report overdue findings.

## Required evidence

- Scan configuration and results.
- Triage/remediation tickets.
- Exceptions and expiration dates.
- Rescan closure evidence.
- Vulnerability metrics and management review.

## Current FableAgent implementation references

- npm audit and CodeQL workflows are present.
- Container and IaC scanning are not evidenced in current workflows and remain required.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
