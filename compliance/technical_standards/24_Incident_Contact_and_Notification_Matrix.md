# Incident Contact and Notification Matrix

*Escalation, decision and notification responsibilities*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-IR-024 |
| Version | 0.1 — Draft for review |
| Owner | Incident Response Lead |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Contact matrix

| Contact | Details | Trigger/timing | Responsibility |
|---|---|---|---|
| Internal security lead | [NAME / 24x7 PHONE / EMAIL — REQUIRED] | Immediately | Triage, containment and incident command |
| Privacy Officer | [NAME / PHONE / EMAIL — REQUIRED] | Immediately for suspected PHI event | Permitted-use and breach assessment |
| Executive lead | [NAME / PHONE / EMAIL — REQUIRED] | Severity High/Critical | Resources, business and communications decisions |
| Healthcare counsel | [FIRM / 24x7 CONTACT — REQUIRED] | Potential reportable breach or legal process | Privilege, legal analysis and notices |
| Cyber insurer/breach coach | [POLICY / HOTLINE — REQUIRED] | Per policy before covered response costs | Carrier authorization and vendors |
| Affected clinic/customer | Per customer incident annex | Contract deadline; target initial notice within 24 hours | Business-associate notice and coordination |
| Cloud/vendor | Per vendor register | Immediately for provider containment/support | Logs, containment and service notices |
| HHS OCR | HHS breach portal | Covered entity ordinarily reports; coordinate under BAA | HIPAA notice |
| Texas Attorney General | Texas AG electronic breach portal | If applicable: as soon as practicable, no later than 30 days for 250+ Texans | Texas report |
| Law enforcement | Counsel-directed | As appropriate | Criminal threat/evidence coordination |

## Purpose

Ensure incidents are escalated and legally/contractually evaluated without delay or dependence on memory.

## Scope

Security incidents, impermissible PHI use/disclosure, suspected breach, ransomware, lost devices, vendor incidents, integrity/availability failures and near misses.

## Requirements

- The matrix must contain tested primary and backup contacts and customer-specific deadlines before live PHI.
- Initial customer notification must not be delayed while every fact is gathered; updates follow as facts become available.
- Only authorized personnel and counsel make regulatory/media notifications.
- All decisions, times and communications must be preserved.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Reporter contacts Security immediately and preserves evidence.
- Incident Lead opens record, assigns severity and starts timeline.
- Privacy/counsel perform breach and jurisdiction analysis.
- Notify customer/vendor/insurer according to trigger and shortest deadline.
- Document updates, corrective action and post-incident review.
- Test the matrix through a tabletop at least annually and after major change.

## Required evidence

- Completed contacts and customer annexes.
- Tabletop call-tree results.
- Incident timeline and decisions.
- Notification copies/confirmations.
- Post-incident corrective-action record.

## Current FableAgent implementation references

- Application captures authentication, audit and job events but organizational contacts are not supplied by source code.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
- HHS Breach Notification Rule: https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html
- Texas AG breach reporting: https://www.texasattorneygeneral.gov/consumer-protection/data-breach-reporting
