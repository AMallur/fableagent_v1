# Secure Software-Development Lifecycle

*Security and privacy requirements from design through retirement*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-SDLC-015 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Lifecycle gates

| Phase | Required activity | Exit evidence |
|---|---|---|
| Plan | Data classification, PHI purpose, scope, owner and acceptance criteria | Approved issue/requirements |
| Design | Threat model, tenant/privacy impact, logging and retention decisions | Design/security review |
| Build | Least privilege, secure coding, secrets prohibition, dependency control | Peer-reviewed code |
| Test | Unit/integration, negative authorization, RLS, scanning and regression tests | Passing CI and test report |
| Release | Change approval, migration review, rollback, production gates | Approved deployment record |
| Operate | Monitoring, vulnerability remediation, incident handling, access review | Operational evidence |
| Retire | Data export/deletion, credential revocation and evidence preservation | Retirement approval |

## Purpose

Integrate security, privacy and HIPAA safeguards into every software change affecting the FableAgent boundary.

## Scope

Application, database schema, infrastructure, integrations, CI/CD, scripts, documentation and third-party components.

## Requirements

- PHI and security requirements must be explicit acceptance criteria.
- Changes to authentication, authorization, tenant scoping, audit, encryption, data flow, retention or integrations require Security review.
- Production testing uses synthetic or approved de-identified data unless specifically authorized in the HIPAA environment.
- Critical unresolved security findings block release.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Classify the change and affected data/control.
- Perform threat/privacy review proportional to risk.
- Implement with peer review and automated tests.
- Run security and dependency scans.
- Approve deployment and verify controls after release.
- Monitor and retain evidence.

## Required evidence

- Requirements/design review.
- Approved pull request.
- CI and scan results.
- Deployment/change record.
- Post-release verification.
- Vulnerability remediation records.

## Current FableAgent implementation references

- .github/workflows/ci.yml and codeql.yml.
- engine/test includes unit, integration, security, API, SFTP and RLS suites.
- docs/PRODUCTION_READINESS.md defines automated and external release gates.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
