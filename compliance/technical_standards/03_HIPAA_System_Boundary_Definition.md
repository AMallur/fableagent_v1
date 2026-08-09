# HIPAA System-Boundary Definition

*Authoritative scope for FableAgent's ePHI environment*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-BND-003 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Boundary statement

- The FableAgent HIPAA system consists of the people, processes, production services, data stores, endpoints, integrations, administrative tools, and evidence repositories that create, receive, maintain, process, or transmit PHI on behalf of customers. Systems are not excluded merely because data is encrypted or the operator does not routinely view it.

## Boundary inventory

| Component | Boundary decision | Conditions |
|---|---|---|
| Production web application and API | IN | Processes and presents PHI |
| Scheduler, ingest and appeal workers | IN | Process claims/remittances and generate documents |
| Production RDS for PostgreSQL | IN | Primary PHI data store |
| Production Cloud Storage | IN | Document and appeal storage |
| Production SFTP | IN | Receives PHI files |
| SMTP provider | CONDITIONAL IN | Only after BAA and approved minimum-necessary content |
| Clearinghouse/payer connectors | IN when enabled | Contract, BAA, authorization and certification required |
| Identity/SSO provider | IN supporting service | Handles identities and access; assess and contract appropriately |
| Central logging/monitoring | IN supporting service | May receive identifiers/metadata; PHI minimization required |
| GitHub and CI | OUT | No PHI; synthetic data and source only |
| Development and test | OUT | No live PHI; separate projects/accounts/secrets |
| Personal email, consumer file sharing, unmanaged devices | PROHIBITED | No PHI permitted |
| AI/LLM providers | OUT by default | May enter only after Privacy/Security approval, BAA and eligible-service review |

## Purpose

Establish which systems and personnel are subject to the FableAgent HIPAA program and prevent undocumented scope assumptions.

## Scope

All production tenants, customers, workforce identities and supporting vendors.

Compliance evidence and administrative access systems that can affect ePHI confidentiality, integrity, or availability.

## Requirements

- The Security Officer owns the boundary inventory.
- A material architecture or data-use change requires boundary review before implementation.
- Out-of-bound systems must be technically and procedurally prevented from receiving PHI.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Compare asset inventory to the PHI data-flow and architecture diagrams.
- Interview system owners and inspect cloud/vendor configurations.
- Classify each asset IN, OUT, CONDITIONAL, or PROHIBITED.
- Record rationale, owner, location, and PHI function.
- Approve and link boundary changes to risk and change records.

## Required evidence

- Approved boundary register.
- Asset inventory reconciliation.
- Change tickets and approval records.
- Evidence of development/production separation.

## Current FableAgent implementation references

- docs/PRODUCTION_READINESS.md.
- .env.example and docker-compose.cloudsql.yml.
- README.md — security, integrations, and deployment sections.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
