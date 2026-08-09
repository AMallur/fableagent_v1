# PHI Data-Flow Diagram and Narrative

*Where protected health information enters, moves, is stored, and leaves FableAgent*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-DF-001 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose and scope

- This document defines the intended production flow of PHI through FableAgent. It covers 837P claims, 835 remittances, structured API payloads, manually uploaded files, appeal documents, operational user activity, audit evidence, and approved outbound delivery.

## Flow inventory

| Stage | PHI/data | Control point | Current status |
|---|---|---|---|
| Source | Patient demographics, diagnoses, procedures, claim identifiers, payer data | Provider authorization; BAA; approved transfer method | External gate |
| Ingress | 837P, 835, CSV, JSON, PDF/document | TLS/API key, upload validation, per-client SFTP confinement, size limits | Implemented in code; production configuration unverified |
| Processing | Parsed claims, remittances, recovery findings, appeal content | Tenant and client context, RLS, authorization, deterministic jobs | Implemented in repository |
| Storage | Database records and documents | RDS for PostgreSQL encryption/HA/PITR; private S3 with IAM/versioning/retention | RDS for PostgreSQL design present; S3 hardening and evidence required |
| Access | Screens, APIs, exports, downloads | Unique identity, MFA standard, RBAC, session control, PHI access logging | Partial: admin MFA implemented; all-PHI-user enforcement required |
| Outbound | Appeals, claim-related transactions, approved notifications | Connector authorization, tracking, minimum necessary, no PHI email unless approved | Connectors fail closed; production contract/certification required |
| Termination | Customer PHI, backups, audit evidence | Export, return/destruction, backup aging, certificate | Procedure defined in separate document; automation/evidence required |

## Purpose

Maintain a current, reviewable record of all PHI movements and associated safeguards.

## Scope

Production application, scheduler, SFTP, public API, database, document storage, SMTP and clearinghouse connectors.

Development and CI are outside the PHI boundary and may use synthetic or properly de-identified data only.

## Requirements

- Every new source, sink, vendor, data category, or transfer method must be added before use.
- PHI may not flow to logging, analytics, support, or AI services unless the exact service is approved and a BAA is executed when required.
- The diagram must match the system-boundary, vendor register, retention schedule, and incident plan.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Inventory current interfaces and data elements.
- Validate the diagram with Engineering, Privacy, and Security.
- Trace a test record from ingress through deletion using synthetic data.
- Record gaps in the risk register and block live PHI for uncontrolled flows.
- Approve and version the diagram.

## Required evidence

- Approved diagram and revision history.
- Synthetic end-to-end trace results.
- Interface inventory and data dictionary.
- Risk-register entries for unresolved flows.

## Current FableAgent implementation references

- README.md — integration, ingestion and storage architecture.
- engine/src/integration/sftp_server.ts and public_api.ts.
- engine/src/appeals/storage.ts.
- db/migrations — patient, claim, remittance, document, audit and RLS tables.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
