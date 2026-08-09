# Tenant-Isolation Specification

*Defense-in-depth separation of customer PHI*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-ISO-011 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Purpose

Prevent one tenant or client from accessing, referencing, modifying, exporting, or influencing another tenant's PHI.

## Scope

Database rows, APIs, web queries, jobs, files, SFTP folders, object paths, caches, logs, exports, integrations and support tools.

## Requirements

- Every tenant-scoped table carries tenant_id and uses composite relationships where applicable.
- PostgreSQL RLS must be enabled and forced for runtime access; application predicates are an additional control, not a replacement.
- Tenant context must be set for each request/job and reset before pooled connection reuse.
- Runtime roles must not retain owner, superuser or BYPASSRLS privileges.
- SFTP and document paths must reject traversal and remain tenant/client scoped.
- Every release touching data access requires positive and negative cross-tenant tests.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Create two synthetic tenants with distinct users and records.
- Attempt UI, API, direct runtime SQL, job, document and SFTP cross-tenant access.
- Verify requests fail without disclosing record existence.
- Review migration grants, owner roles and SECURITY DEFINER functions.
- Retain test and database-role evidence before release.

## Required evidence

- RLS policy and grants export.
- Non-superuser RLS test results.
- Cross-tenant API/UI/SFTP/document tests.
- Runtime role membership evidence.
- Migration review approval.

## Current FableAgent implementation references

- db/migrations/0002_tenancy_and_users.sql establishes tenant_id and composite constraints.
- db/migrations/0008_rls_triggers_grants.sql enables FORCE RLS.
- db/migrations/0019_runtime_rls_and_delivery.sql removes migration-only owner membership.
- engine/src/db/tenant_pool.ts sets and resets app.current_tenant_id.
- engine/test/rls_runtime.test.ts provides non-superuser regression tests.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
