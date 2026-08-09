# Approved HIPAA-Eligible Cloud Services List

*Service-by-service approval register for production ePHI*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-SVC-007 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Approval register

| Service | Purpose | Data | Status | Conditions before production |
|---|---|---|---|---|
| Amazon RDS for PostgreSQL | Database | ePHI | Conditional — implemented in Terraform (`aws_db_instance.postgres`), not yet applied to a live account | Execute/confirm AWS BAA; verify HIPAA eligibility, Multi-AZ, backups, IAM, logging and region |
| Amazon S3 | Documents/backups | ePHI | Conditional — implemented in Terraform (`aws_s3_bucket.documents`), not yet applied to a live account | Private bucket (done); IAM (done); versioning (done); retention (done); access logging via CloudTrail S3 data events (done); restore test still required |
| RDS connectivity (TLS, private subnet, task IAM role) | Database connectivity | Encrypted connection metadata | Conditional — implemented | `PGSSLMODE=verify-full`, `rds.force_ssl=1`, no public accessibility, ECS task IAM role scoped to specific secret ARNs — no static long-lived DB credential outside Secrets Manager |
| AWS ECS Fargate | Runtime | ePHI in memory | Conditional — task definitions implemented (`aws_ecs_task_definition.app/scheduler/migration`), services scaled to zero until `services_enabled=true` | Confirm HIPAA eligibility, hardening (`readonlyRootFilesystem`, least-privilege task role) before first real run |
| AWS Secrets Manager | Secrets | No PHI intended | Implemented | Least privilege via `aws_iam_role_policy.execution_secrets` (scoped to specific ARNs), KMS-encrypted, rotation still to be scheduled |
| Amazon CloudWatch Logs/Alarms | Telemetry | Metadata; no PHI by design (enforced by `engine/src/security/logging.ts` redaction) | Implemented | Retention configured (`log_retention_days`); PHI-safe logging standard governs content |
| GitHub | Source/CI | No PHI | Approved outside boundary | Synthetic data only; prohibit secrets and production exports |
| AWS Application Load Balancer | TLS termination (ECS/ALB production path) | Encrypted traffic | Implemented — gated behind `deploy_paid_infrastructure` | TLS 1.2+ policy configured; optional AWS WAF (`enable_edge_waf`) recommended before production PHI |
| Caddy | TLS reverse proxy (single-EC2-host SFTP-pilot path only, not the default ECS path) | Encrypted traffic | Software component | Patch and configuration management; not a cloud vendor approval |
| SMTP provider | Notifications | No PHI by default | Not selected | Select BAA-capable provider and approve message content |
| Optum/Change or other clearinghouse | Claims/EDI | ePHI | Not approved for production (sandbox only) | Production trading-partner agreement, BAA, authorization and technical certification |
| AI/LLM provider | AI processing | Prohibited by default | Not approved | Separate written approval, BAA, eligible service and no-training terms required — see `22_AI_LLM_PHI_Use_and_Model_Training_Restrictions.md` |

## Purpose

Authorize exact cloud services and configurations that may be used within the HIPAA boundary.

## Scope

All SaaS, PaaS, IaaS, storage, identity, telemetry, communications and AI services that may affect PHI.

## Requirements

- No service may receive PHI until the status is Approved and all listed conditions are evidenced.
- A provider-level BAA does not automatically approve every product, feature, region or support channel.
- Changes require vendor, privacy, security and architecture review.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Identify the exact service and feature set.
- Confirm BAA and HIPAA-eligible scope using current provider documentation.
- Assess data categories, region, subprocessors, retention, support access and incident terms.
- Record conditions and evidence links.
- Approve before enabling production data.

## Required evidence

- Executed BAA and service terms.
- Service eligibility screenshot/export and review date.
- Architecture and configuration approval.
- Periodic reassessment record.

## Current FableAgent implementation references

- .env.example; infra/aws/terraform/main.tf, security.tf, hardening.tf; engine/src/appeals/storage.ts; engine/package.json.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
