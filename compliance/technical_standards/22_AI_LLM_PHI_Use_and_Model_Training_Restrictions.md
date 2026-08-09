# AI/LLM PHI Use and Model-Training Restrictions

*Default prohibition and controlled approval of generative-AI processing*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-AI-022 |
| Version | 0.1 — Draft for review |
| Owner | Privacy Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose

Prevent unauthorized disclosure, retention, secondary use or model training involving PHI through AI and machine-learning services.

## Scope

Public chatbots, coding assistants, hosted model APIs, embeddings/vector stores, transcription, OCR, analytics, agents, evaluation tools, support tools and internally trained models.

## Requirements

- PHI is prohibited in any AI/LLM system unless the exact use case, provider, service, endpoint, retention mode and data flow receive written Privacy and Security approval.
- A required BAA must be executed and the service must be specifically eligible; enterprise branding or encryption alone is insufficient.
- Provider terms must prohibit training and unauthorized human review and define retention/deletion, subprocessors, location, incident notification and support access.
- Only minimum-necessary fields may be sent; direct identifiers must be removed when not required.
- Outputs are decision support and require qualified human review before claim, coding, appeal or patient-impacting action.
- Prompts, outputs, evaluations and traces are PHI when they contain identifiable health information and must follow the same controls.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Submit an AI use-case request describing purpose, data, model, endpoint and users.
- Perform privacy, security, clinical/billing and vendor review.
- Execute BAA/terms and approve technical configuration.
- Implement minimization, access, logging, retention, human review and kill switch.
- Test with synthetic data before limited production approval.
- Monitor use, model/provider changes and deletion evidence.

## Required evidence

- Approved AI use-case assessment.
- BAA and service eligibility evidence.
- No-training/retention configuration.
- Data-minimization and human-review test.
- Usage/access logs and periodic review.
- Deletion/offboarding evidence.

## Current FableAgent implementation references

- No AI/LLM runtime dependency was identified in engine/package.json as inspected.
- This policy preserves the current default: no PHI to AI services unless separately approved.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
