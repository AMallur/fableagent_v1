# Control-to-Code Traceability Matrix

*Mapping HIPAA safeguards to FableAgent implementation, tests, and evidence*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-CTL-004 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Status legend

- Implemented: repository contains a corresponding control, subject to production verification.
- Partial: control exists but scope/configuration is insufficient for the adopted standard.
- Designed: repository or procedure anticipates the control, but production evidence is missing.
- Required: no sufficient implementation or evidence has been established.

| ID | HIPAA reference | Control | Implementation | Verification/evidence | Status |
|---|---|---|---|---|---|
| AC-01 | 164.308(a)(4), 164.312(a) | Unique identities and RBAC | app_user roles; admin_api authorization; visibleClientIds | security/admin integration tests | Partial |
| AC-02 | 164.308(a)(4) | Minimum necessary | tenant/client scoped queries and role checks | cross-role API/UI tests | Partial |
| AC-03 | 164.312(a) | Tenant isolation | PostgreSQL FORCE RLS; tenant_pool context | test/rls_runtime.test.ts | Implemented |
| IA-01 | 164.312(d) | Authentication | scrypt password verification; lockout | test/security.test.ts | Implemented |
| IA-02 | 164.312(d) | MFA | TOTP for admin roles when enforce_mfa | security/web tests | Partial — require all PHI users |
| SE-01 | 164.312(a) | Session control | HMAC-signed expiring cookies; configurable sliding timeout | web integration tests | Implemented; production config evidence required |
| AU-01 | 164.312(b) | Audit trail | append-only audit_log triggers and app security events | DB integration tests | Implemented |
| AU-02 | 164.312(b) | PHI access logging | compliance API and phi_accessed events | API/web tests | Implemented |
| SC-01 | 164.312(e) | Transmission security | ALB TLS 1.2+ (`aws_lb_listener.https`, ECS/ALB path); Caddy TLS (single-EC2-host SFTP-pilot path only); RDS `verify-full`/`force_ssl` (private subnet, no proxy needed); SSH2 SFTP | deployment/TLS/SFTP tests | Designed |
| SC-02 | 164.312(a),(e) | Encryption at rest | RDS/S3 platform encryption; AES-256-GCM for selected secrets | cloud configuration export | Designed/partial |
| CM-01 | 164.308(a)(1) | Change control | GitHub PR/CI workflow | approved PR and CI run | Partial — branch settings not verified |
| VM-01 | 164.308(a)(1) | Vulnerability management | npm audit and CodeQL | workflow evidence/remediation tickets | Partial |
| CP-01 | 164.308(a)(7) | Backups and recovery | RDS for PostgreSQL backup/PITR provisioning | restore test | Designed — test required |
| CP-02 | 164.308(a)(7) | Document durability | S3 DocumentStore | S3 integration and restoration tests | Partial — bucket controls required |
| IR-01 | 164.308(a)(6) | Incident response | security event capture | tabletop and incident log | Required operationally |
| VR-01 | 164.308(b) | Vendor/BAA management | BAA acknowledgment during client onboarding | executed BAAs/vendor reviews | Required externally |
| TR-01 | 164.308(a)(5) | Training | No repository control expected | completion records | Required |
| DS-01 | 164.310(d) | Data disposal | soft delete and storage paths; no complete lifecycle | deletion test/certificate | Required |
| AI-01 | 164.502, BAA limits | AI use restriction | No LLM dependency detected | vendor/code scan and attestation | Policy required |

## Purpose

Provide auditable traceability from HIPAA requirements and internal policy statements to technical or operational controls, tests, evidence, owners, and remediation.

## Scope

All controls that protect FableAgent ePHI and all material BAA obligations.

## Requirements

- Every adopted control must have an owner, implementation statement, verification method, evidence location, review frequency, and status.
- A passing code test is not production evidence unless the tested configuration matches production.
- Control failures must create risk or remediation records.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Review each regulatory requirement and policy commitment.
- Map it to the smallest verifiable control statement.
- Link code/configuration, test, evidence and owner.
- Validate status with current evidence.
- Track gaps to closure and approve the matrix.

## Required evidence

- Approved matrix export.
- Linked CI, cloud, access, training and vendor evidence.
- Gap remediation tickets and risk acceptances.

## Current FableAgent implementation references

- README.md and docs/PRODUCTION_READINESS.md.
- .github/workflows/ci.yml and codeql.yml.
- engine/src/web/auth.ts; security/*; db RLS/audit migrations.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
