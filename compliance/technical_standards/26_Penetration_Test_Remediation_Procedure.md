# Penetration-Test Remediation Procedure

*Triage, correction, validation and closure of independent security findings*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-PEN-026 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Remediation service levels

| Severity | Initial action | Target treatment | Release impact |
|---|---|---|---|
| Critical | Immediate containment and executive/security notification | Fix or verified mitigation as soon as practicable; target 24–72 hours | Blocks production/release |
| High | Triage within 1 business day | Target 15 days unless stricter risk requires | Normally blocks affected release |
| Medium | Triage within 5 business days | Target 60 days | Track; risk-based release decision |
| Low | Triage within 10 business days | Target 90 days or planned hardening | Does not alone block release |
| Informational | Review | Accept, document or backlog | No direct block |

## Purpose

Ensure independent penetration-test findings receive accountable, risk-based treatment and verified closure.

## Scope

Application, API, authentication, tenant isolation, cloud, storage, SFTP, network and authorized social/operational scope.

## Requirements

- Testing must use a written scope, rules of engagement, synthetic data and approved tester access.
- Reports and evidence are confidential security records.
- Severity may be adjusted only with documented rationale and Security approval.
- Closure requires independent retest or equivalent objective validation; code merge alone is not closure.
- Known critical/high findings affecting PHI remain a production blocker absent documented exceptional decision by Security and executive leadership.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Receive report and restrict distribution.
- Create one tracked item per finding with asset, owner, severity and due date.
- Validate exploitability and PHI impact.
- Remediate and test internally.
- Obtain tester retest or objective validation.
- Record closure, residual risk and lessons learned.

## Required evidence

- Signed rules of engagement.
- Final report and finding tracker.
- Remediation pull requests/change records.
- Retest letter/results.
- Risk acceptance and management summary where applicable.

## Current FableAgent implementation references

- Current repository has security, integration and RLS tests but no independent production penetration-test report was identified.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
