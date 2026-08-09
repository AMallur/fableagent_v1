# Risk Register and Remediation Tracker

*Initial FableAgent HIPAA risk-management record*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-RSK-005 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Initial risk register

| ID | Risk scenario | Rating | Required treatment | Owner | Status |
|---|---|---|---|---|---|
| R-01 | Live PHI enters before BAAs are executed | High | Block production onboarding; BAA gate and vendor register | Privacy Officer | Open |
| R-02 | MFA limited to administrative roles | High | Require MFA for every user with PHI access | Engineering | Open |
| R-03 | S3 bucket restore procedure unverified (versioning, retention and access logging are implemented in Terraform, but no restore test has been run) | High | Complete an S3/RDS restoration test | Cloud Owner | Open |
| R-04 | Local document volume loss | High | Prohibit local store for production; require S3 (`aws_s3_bucket.documents`, already implemented) | Engineering | Open |
| R-05 | SMTP provider or content exposes PHI | High | Execute BAA; minimize content; test transport and logs | Privacy/Engineering | Open |
| R-06 | Clearinghouse connector sends without approved agreement or certification | High | Maintain fail-closed behavior; approve contract and testing | Integration Owner | Open |
| R-07 | Audit before/after state captures excessive PHI | High | Review/redact sensitive fields; protect retention and access | Security/Engineering | Open |
| R-08 | No verified production restore/failover exercise | High | Complete BCP/DR and backup restoration exercises | Cloud Owner | Open |
| R-09 | Secrets supplied through environment without managed rotation | Medium | Adopt Secret Manager/mounted secrets and rotation records | Security | Open |
| R-10 | Cross-tenant access through future query or migration | High | RLS regression suite, mandatory tenant test and migration review | Engineering | Mitigated; monitor |
| R-11 | PHI copied to GitHub, CI, support or analytics | High | Synthetic-only rule, DLP/secret scans, workforce training | Security | Open |
| R-12 | Unapproved LLM receives PHI or retains prompts | High | Default prohibition; approval/BAA/eligible-service gate | Privacy/Security | Open |
| R-13 | Retention/deletion obligations cannot be completed | High | Implement per-customer schedule and deletion evidence | Engineering/Privacy | Open |
| R-14 | Role grants exceed job need | Medium | Approve role matrix and quarterly access review | System Owner | Open |
| R-15 | SFTP credential compromise | High | Rotation, rate limits, monitoring and per-client confinement tests | Integration Owner | Partial |
| R-16 | Vulnerable dependency or image reaches production | High | Dependency/container/IaC scanning and remediation SLA | Engineering | Partial |
| R-17 | Incident notification misses contractual/Texas deadline | High | Contact matrix, counsel escalation and tabletop | Incident Lead | Open |
| R-18 | Corrected claim or appeal is submitted without human authorization | High | Certified human review and submission evidence | RCM Owner | Open |

## Purpose

Maintain a living record of risks to ePHI confidentiality, integrity, availability, permitted use, and contractual obligations.

## Scope

All in-boundary assets, vendors, workforce practices, integrations and operational processes.

## Requirements

- Risk ratings must consider likelihood, impact, affected PHI, exploitability, detectability and existing safeguards.
- Every non-low risk requires treatment, owner, target date and validation.
- Risk acceptance must be explicit, time-limited and approved; it may not replace a required HIPAA safeguard.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Identify threats, vulnerabilities, affected assets and current controls.
- Rate inherent and residual risk using the approved methodology.
- Select avoid, mitigate, transfer or accept treatment.
- Create remediation tasks with target dates.
- Validate closure using evidence and reassess after material changes.

## Required evidence

- Risk register revision history.
- Remediation tickets and closure evidence.
- Risk acceptance approvals.
- Periodic management review minutes.

## Current FableAgent implementation references

- docs/PRODUCTION_READINESS.md lists unresolved external production gates.
- Repository security tests and cloud deployment artifacts support initial control observations.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
