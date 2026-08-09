# Role and Permission Matrix

*Minimum-necessary application and administrative privileges*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-IAM-010 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Application role matrix

| Role | Purpose | Permitted | Prohibited/limit | Approver |
|---|---|---|---|---|
| super_admin | Platform administration within authorized scope | Platform/tenant configuration; controlled support | No routine cross-customer PHI access; separately approved support access | Security Officer + executive |
| tenant_admin | Customer/tenant administrator | All clients in tenant; users; settings; compliance views | Cannot bypass platform security/RLS | Customer authorized official |
| client_admin | Single-client administrator | Own client users/settings and operational data | No other clients; cannot grant tenant_admin | Tenant admin |
| biller | Billing/appeal operations | Claims, remittances, cases, appeal workflow for assigned scope | No user/security administration | Client/tenant admin |
| collector | Follow-up and recovery operations | Cases, payer follow-up and payment reconciliation for assigned scope | No user/security administration | Client/tenant admin |
| viewer | Read-only review | Approved dashboards and records in assigned scope | No mutation, submission or administration | Client/tenant admin |
| service identities | Scheduled/API/SFTP processing | Only functions and tenants required for workload | No interactive login; no broad owner/BYPASSRLS membership | Security + System Owner |

## Purpose

Implement minimum-necessary access through defined roles, client scope, tenant isolation and controlled service identities.

## Scope

Application, database, cloud, source control, compliance repository, integrations and support access.

## Requirements

- Access requires a named user, approved role, approved tenant/client scope and business justification.
- Role combinations and service permissions must avoid incompatible duties where practicable.
- Privileged and dormant access must be reviewed at least quarterly; termination access must be removed promptly.
- Support access to customer PHI requires ticket, approval, time limit and audit trail.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Manager submits access request with role and scope.
- System Owner verifies minimum necessary and separation of duties.
- Administrator provisions unique identity and MFA.
- User acknowledges policy and completes training.
- Reviewer validates access quarterly and removes or corrects excess access.

## Required evidence

- Approved access request.
- Current user/role export.
- Quarterly review sign-off.
- Deactivation record.
- Privileged/support access logs.

## Current FableAgent implementation references

- db/migrations/0001_extensions_and_helpers.sql defines six user roles.
- engine/src/web/admin_api.ts restricts tenant/client administration and role grants.
- engine/src/web/auth.ts and db/tenant_pool.ts enforce scope.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
