# Cloud Shared-Responsibility Matrix

*FableAgent and cloud-provider responsibilities for ePHI*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-CLD-006 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Responsibility matrix

| Control area | Primary responsibility | FableAgent obligation |
|---|---|---|
| Physical datacenter | AWS | Review assurance reports (SOC 2/3) and BAA scope |
| Underlying compute/storage infrastructure | AWS | Select HIPAA-eligible services and regions; review service status |
| Cloud BAA | Shared | AWS offers the BAA via AWS Artifact; FableAgent must accept it and stay within HIPAA-eligible services |
| Account and organization configuration | FableAgent | Dedicated production AWS account, billing, ownership, contacts |
| IAM and service/task roles | FableAgent | Least privilege, no shared identities, periodic review (`aws_iam_role.execution`, `aws_iam_role.task`) |
| Network exposure | FableAgent | VPC/security-group configuration, TLS, ALB/WAF configuration (`infra/aws/terraform/main.tf`, `hardening.tf`) |
| RDS for PostgreSQL configuration | Shared | AWS operates the managed service; FableAgent configures Multi-AZ, backups, users, logging and access (`aws_db_instance.postgres`) |
| Database schema/RLS | FableAgent | Migrations, tenant context, grants, regression testing |
| S3 bucket security | FableAgent | Private access, IAM, versioning, retention, logging and lifecycle (`aws_s3_bucket.documents`) |
| Encryption platform | Shared | AWS provides KMS; FableAgent controls the customer-managed key (`aws_kms_key.phi`), application secrets, and access |
| Key/secret lifecycle | FableAgent | Generate, store, rotate, revoke and document |
| Application security | FableAgent | Authentication, authorization, validation, logging, patching and SDLC |
| Backups and restoration | Shared | Provider supplies capability; FableAgent configures, monitors and tests restoration |
| Monitoring and incident response | Shared | Provider service notices; FableAgent alerts, investigates, contains and notifies |
| Data retention/deletion | FableAgent | Configure lifecycle and verify customer-specific deletion |
| Subprocessors | Shared | Provider manages listed subprocessors; FableAgent evaluates contractual and risk implications |

## Purpose

Prevent the mistaken assumption that a cloud BAA or provider security controls make FableAgent compliant automatically.

## Scope

Every production cloud service and supporting identity, logging, networking and storage control.

## Requirements

- FableAgent remains responsible for configuration, access, use, monitoring, evidence and vendor management within the shared-responsibility model.
- Provider documentation must be reviewed for each exact service, not the brand generally.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- List every cloud service and data category.
- Obtain provider responsibility/security documentation.
- Assign each safeguard to provider, FableAgent, or shared.
- Link FableAgent responsibilities to controls and evidence.
- Review after service or contract changes.

## Required evidence

- Executed BAA.
- Eligible-services decision record.
- IAM and asset exports.
- Backup/restore and monitoring evidence.
- Annual vendor/security review.

## Current FableAgent implementation references

- infra/aws/terraform/main.tf, security.tf, hardening.tf.
- engine/src/appeals/storage.ts (cloud-agnostic storage abstraction; the S3 implementation is the one actually deployed).
- docs/PRODUCTION_READINESS.md.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
- AWS HIPAA Compliance / AWS Artifact: https://aws.amazon.com/compliance/hipaa-compliance/
