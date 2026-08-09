# Environment-Separation Standard

*Isolation of development, test, staging and production*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-ENV-018 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Environment rules

| Environment | Data | Access | External connectivity |
|---|---|---|---|
| Development | Synthetic only | Developers; no production credentials | Sandbox endpoints only |
| CI/test | Synthetic fixtures and ephemeral test DB | Automated identities | Package registries and test services only |
| Staging | Synthetic or formally de-identified data | Limited engineering/QA | Sandbox integrations; no production delivery |
| Production | Authorized live PHI | Approved trained users and service identities | Only contracted/approved vendors and endpoints |

## Purpose

Prevent live PHI, production credentials and production authority from leaking into non-production environments.

## Scope

AWS accounts, databases, storage, identity, secrets, networks, CI/CD, integrations and support tooling.

## Requirements

- Production must use separate project/resources, identities, secrets, storage and integration credentials.
- No production database copy may be used outside production without approved de-identification and validation.
- Non-production email and clearinghouse connections must be sandbox or sink endpoints.
- Deployments flow from reviewed source to production; production changes do not flow backward as data.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Inventory environment resources and owners.
- Create separate projects/accounts and service identities.
- Configure synthetic data and sandbox integrations.
- Test denial of cross-environment access and secret reuse.
- Review evidence before go-live and after topology changes.

## Required evidence

- Environment inventory.
- AWS account and IAM export.
- Secret comparison/rotation evidence.
- Synthetic-data attestation.
- Cross-environment access test.

## Current FableAgent implementation references

- CI uses ephemeral PostgreSQL and test-only secrets.
- docker-compose.yml (local, containerized Postgres) is kept separate from the production `infra/aws/terraform/` (RDS) topology; there is currently one Terraform configuration, not yet separate per-environment AWS accounts/projects — a real gap this standard flags as required before production.
- Production project/account separation is not evidenced in source and must be verified externally.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
