# Vendor and Subprocessor Register / BAA Tracker

*FableAgent third-party PHI oversight register*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-VEN-008 |
| Version | 0.1 — Draft for review |
| Owner | Privacy Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Initial register

| Vendor | Service | PHI access | BAA status | Criticality | Review timing |
|---|---|---|---|---|---|
| AWS | Hosting, RDS, S3, KMS, ECS, CloudTrail/Config/GuardDuty/Security Hub | Yes | In progress — per founder, BAA acceptance was initiated in AWS Artifact; confirm final execution date and record it here | Critical | Before PHI and annually/material change |
| GitHub | Source control and CI | No PHI permitted | Not relied upon | High | Annually |
| SMTP provider — TBD | Email delivery | Potential | Required before PHI | High | Before activation |
| Optum/Change Healthcare — TBD | Clearinghouse/API | Yes | Required | Critical | Before production contract |
| Availity — alternative/TBD | Clearinghouse/API | Yes if selected | Required | Critical | Before activation |
| Identity/SSO provider — customer-specific | Authentication | Identifiers/metadata | Review required | High | Before federation |
| Penetration-test firm — TBD | Security testing | Synthetic preferred; potential access | Determine by scope | High | Before engagement |
| Healthcare legal counsel — TBD | Contract/legal review | Avoid PHI; possible incident access | Determine by engagement | High | Before engagement |
| AI/LLM provider | Not approved | PHI prohibited | N/A until approved | Critical | Before any use |

## Purpose

Inventory and oversee every vendor or subprocessor that creates, receives, maintains, transmits, supports, or can access PHI.

## Scope

Production vendors, professional services, support channels, subcontractors and customer-selected integrations.

## Requirements

- The register must include service owner, contract, BAA, data, location, subprocessors, security review, incident contact, renewal and termination evidence.
- No PHI may be shared while a required BAA or security approval is missing.
- Subcontractor obligations must flow down as required by the BAA.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Screen vendor and identify data/access.
- Review security, privacy, incident, deletion, location and subprocessor terms.
- Execute BAA and commercial agreement as applicable.
- Approve and configure least-privilege access.
- Monitor changes and offboard with deletion evidence.

## Required evidence

- Signed agreements and BAAs.
- Vendor security review.
- Subprocessor list and change notices.
- Annual/material-change review.
- Termination and deletion evidence.

## Current FableAgent implementation references

- README.md notes BAA acknowledgment and external production gates.
- docs/PRODUCTION_READINESS.md requires BAAs with hosting, storage, email and integrations.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
