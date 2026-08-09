# Code-Review and Deployment-Approval Procedure

*Controlled peer review, release authorization and production verification*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-DEP-016 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose

Ensure production changes are reviewed, tested, authorized, reversible and attributable.

## Scope

Source code, migrations, Docker images, CI workflows, configuration, infrastructure and integration changes.

## Requirements

- No direct unreviewed production changes except documented emergency procedure.
- At least one qualified independent reviewer is required; security-sensitive changes require Security Officer or delegate review.
- CI must pass unit, integration, non-superuser RLS, dependency audit, image build and configured static analysis gates.
- Migration privileges and rollback/recovery steps require explicit review.
- Deployment approval must identify version, environment, evidence, approver and verification result.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Open a change record and pull request with risk and rollback information.
- Reviewer verifies functionality, PHI handling, authorization, logging, tests and dependencies.
- Resolve comments and obtain required approval.
- Run CI and preserve results.
- Authorized deployer releases the immutable version.
- Perform post-deployment checks and close or roll back.

## Required evidence

- Pull request and review approvals.
- Branch protection configuration.
- CI/CodeQL/dependency results.
- Deployment and rollback record.
- Post-deployment validation.

## Current FableAgent implementation references

- .github/workflows/ci.yml runs tests, RLS regression, npm audit and Docker build.
- .github/workflows/codeql.yml runs CodeQL.
- GAP: hosted branch-protection and deployment-approval settings require verification outside the repository.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
