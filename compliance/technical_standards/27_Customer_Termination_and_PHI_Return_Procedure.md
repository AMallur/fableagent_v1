# Customer Termination and PHI Return Procedure

*Controlled export, return, destruction and access revocation*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-OFF-027 |
| Version | 0.1 — Draft for review |
| Owner | Privacy Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Termination checklist

| Phase | Required action | Evidence |
|---|---|---|
| Authorize | Confirm termination date, contract/BAA duties, legal holds, export scope and contacts | Approved termination ticket |
| Stabilize | Disable new ingest/submission and preserve required records | Configuration/audit evidence |
| Export | Produce agreed database/document export using encrypted approved transfer | Manifest, checksum and transfer receipt |
| Confirm | Customer validates receipt and completeness | Written acceptance |
| Revoke | Remove customer users, API/SFTP/integration credentials and vendor access | Access and credential revocation logs |
| Delete | Delete eligible primary data, documents, caches and temporary exports | Deletion job/report |
| Backups | Allow encrypted backups to age out under documented schedule; prevent restoration to active use | Backup lifecycle record |
| Certify | Issue return/destruction statement noting retained legal/evidence exceptions | Signed certificate and exception register |

## Purpose

Meet BAA and contract obligations to return or destroy customer PHI at termination while preserving only information legally or contractually required.

## Scope

RDS for PostgreSQL records, S3 documents, SFTP files, exports, email/outbox content, logs, backups, integration/vendor copies and compliance evidence.

## Requirements

- Termination must follow the executed customer BAA and MSA; no generic schedule overrides stricter terms.
- Exports must be complete, documented, encrypted and delivered only to verified authorized recipients.
- FableAgent may retain PHI only when return/destruction is infeasible or law/contract requires, with continued safeguards and use restrictions.
- Backup residuals must remain inaccessible for ordinary use and expire under documented lifecycle.
- Customer access and credentials must be revoked promptly at the agreed termination point.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Open termination record and identify contract requirements/legal holds.
- Freeze new processing and prepare inventory/export plan.
- Export, checksum, encrypt and transfer; obtain customer confirmation.
- Revoke access/integrations and execute deletion across active systems.
- Document backup aging and retained exceptions.
- Issue certificate and close after Privacy/Security review.

## Required evidence

- Termination approval and data inventory.
- Export manifest/checksums/transfer receipt.
- Access and credential revocation.
- Deletion and backup-lifecycle evidence.
- Customer confirmation and destruction/retention certificate.

## Current FableAgent implementation references

- FableAgent uses soft deletion and separate document storage; complete customer-wide export/deletion automation must be validated or implemented before relying on this procedure.
- BAA return/destruction obligations are an external legal gate.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
