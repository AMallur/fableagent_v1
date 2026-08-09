# Texas Privacy and Breach-Law Addendum

*Texas requirements supplementing the FableAgent HIPAA program*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-TX-025 |
| Version | 0.1 — Draft for review |
| Owner | Privacy Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Texas requirements register

| Area | Operational requirement | FableAgent action |
|---|---|---|
| Texas Medical Records Privacy Act | Texas Health & Safety Code Chapter 181 may apply more broadly or impose additional duties beyond federal HIPAA | Counsel determines covered status, training, authorization and disclosure duties |
| Texas breach notification | Texas Business & Commerce Code Chapter 521 governs notice of breach of sensitive personal information | Run Texas analysis in every incident involving Texas residents |
| Attorney General report | Current Texas AG guidance requires electronic report for breach affecting 250+ Texans as soon as practicable and no later than 30 days after discovery | Counsel/authorized representative prepares and submits; retain confirmation |
| Consumer notice | Affected-consumer notice may be required independently of AG reporting | Coordinate content, timing and responsibility with customer/counsel |
| Training | Texas-specific training obligations may apply based on role and handling | Add Texas module and retain completion evidence after counsel confirms scope |
| Contracts | Customer BAAs/security addenda may allocate shorter deadlines and responsibilities | Maintain customer-specific incident annex and apply shortest controlling deadline |

## Purpose

Overlay Texas medical privacy and breach requirements on FableAgent's federal HIPAA obligations and customer contracts.

## Scope

Texas customers, Texas residents, Texas-located operations and incidents affecting Texas personal or health information.

## Requirements

- Texas analysis is required in addition to HIPAA; federal compliance does not preempt more protective state requirements.
- The Privacy Officer must monitor legislative and Attorney General guidance changes with counsel.
- Customer responsibility allocation does not eliminate FableAgent's independent duties when applicable.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Identify affected individuals, residence, data types and Texas nexus.
- Notify counsel and compare HIPAA, Texas, other-state and contract deadlines.
- Determine responsible notifier and prepare notices/reports.
- Obtain authorized approval and submit through required channels.
- Preserve confirmation and corrective actions.

## Required evidence

- Counsel-approved Texas applicability memo.
- Texas training records where applicable.
- Incident jurisdiction worksheet.
- AG/consumer notice and submission confirmation.
- Annual legal review.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
- Texas Health & Safety Code Chapter 181: https://statutes.capitol.texas.gov/Docs/HS/htm/HS.181.htm
- Texas Business & Commerce Code Chapter 521: https://statutes.capitol.texas.gov/Docs/BC/htm/BC.521.htm
- Texas AG breach reporting guidance: https://www.texasattorneygeneral.gov/consumer-protection/data-breach-reporting
