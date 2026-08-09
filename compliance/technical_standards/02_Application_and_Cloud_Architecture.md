# Application and Cloud Architecture

*Intended HIPAA production architecture and security zones*

| Field | Value |
|---|---|
| Document ID | FA-HIPAA-ARCH-002 |
| Version | 0.1 — Draft for review |
| Owner | Security Officer |
| Prepared | August 3, 2026 |
| Approver | Privacy Officer and Security Officer |
| Review | Before production; then periodically and after material change |
| Classification | Confidential |
| Status | DRAFT — not effective until formally approved |

> **Implementation note —** This document is a FableAgent-specific operating draft. Statements marked Implemented are based on repository inspection, not a production audit. Items marked Required or Conditional must be completed and evidenced before live PHI processing.

## Architecture overview

FableAgent's built and tested production target is **AWS** (`infra/aws/terraform/`), running the application and scheduler on ECS Fargate behind an internet-facing ALB, with RDS for PostgreSQL in private subnets and appeal/claim documents in a private, versioned, KMS-encrypted S3 bucket. TLS is terminated at the ALB (`aws_lb_listener.https`), not by the Caddy reverse proxy — Caddy is used only in the separate single-EC2-host `docker-compose.aws.yml` pilot deployment path (used specifically to support the embedded SFTP server, which Fargate tasks cannot serve since they don't share a persistent local filesystem across replicas), not the primary ECS path.

## Security zones

| Zone | Components | Permitted data | Primary controls |
|---|---|---|---|
| Public edge (ECS/ALB path) | AWS Application Load Balancer (`aws_lb.app`), TLS 1.2+ | Encrypted requests | TLS 1.2+ policy, HTTP→HTTPS redirect, security groups, optional AWS WAF (`enable_edge_waf`) |
| Public edge (single-host pilot path) | Caddy HTTPS endpoint on the EC2 host running `docker-compose.aws.yml` | Encrypted requests | TLS, HSTS, secure cookies, request limits — bounded SFTP-pilot option only, not the default ECS path |
| Application | Node.js web/API/auth services (ECS Fargate task) | PHI necessary for request | RBAC, tenant context, session validation, audit events |
| Worker | Scheduler, ingest and appeal workers (ECS Fargate task) | Tenant-scoped PHI | Service identity, RLS, job ledger, least privilege |
| Data | Amazon RDS for PostgreSQL and Amazon S3 | Persistent ePHI | KMS encryption (`aws_kms_key.phi`), IAM, automated backups, S3 versioning/retention, CloudTrail S3 data events |
| Integration | SFTP, SMTP, clearinghouse connectors | Minimum necessary transaction data | Per-client credentials, BAAs, allowlists, delivery tracking |
| Engineering | GitHub, CI and CodeQL | Source and synthetic data only | Branch review, scanning, secret prohibition, no production data |

## Purpose

Define the production topology, trust boundaries, data stores, integrations, and supporting security services that must be validated before live PHI.

## Scope

AWS is the intended production provider — `infra/aws/terraform/` is the fully-built, Terraform-validated deployment target in this repository (VPC, RDS, S3, ECS Fargate, ALB, KMS, CloudTrail, Config, GuardDuty, Security Hub). References elsewhere in this repository to Google Cloud Storage/Cloud SQL (`docker-compose.cloudsql.yml`, `engine/test/gcs_document_store.test.ts`) exist because the storage abstraction (`engine/src/appeals/storage.ts`) is cloud-agnostic by design, not because GCP is the actual deployment target — do not treat those artifacts as evidence of an intended GCP production environment.

The diagram does not approve a service or establish that a BAA has been executed.

## Requirements

- Production must use BAA-covered services, least-privilege service accounts, centralized monitoring, encrypted durable storage, and separated environments.
- Local filesystem document storage is prohibited for multi-instance or durable production use.
- The final deployed architecture must be reconciled to this document before release.

## Responsibilities

- Privacy Officer: interprets permitted PHI uses, manages BAAs and privacy incidents, and approves disclosures and retention exceptions.
- Security Officer: owns the risk analysis, technical standards, access reviews, incident coordination, and security evidence.
- Engineering Owner: implements and tests application, infrastructure, identity, logging, backup, and deployment controls.
- System Owner: approves production access and accepts residual operational risk for the assigned service.
- Workforce Members: follow approved procedures and promptly report suspected privacy or security events.

## Operating procedure

- Create the production AWS account, IAM roles/policies, and Terraform remote-state backend (`infra/aws/terraform/bootstrap`).
- Execute the AWS BAA (via AWS Artifact) and approve exact services.
- Deploy through controlled infrastructure and record configuration evidence.
- Perform network, IAM, backup, restore, and tenant-isolation tests.
- Update this diagram to the as-built state and approve it.

## Required evidence

- As-built diagram.
- Cloud asset/IAM export.
- BAA and approved-service list.
- Configuration and security test results.
- Architecture-review approval.

## Current FableAgent implementation references

- infra/aws/terraform/main.tf, security.tf, hardening.tf, bootstrap/; infra/aws/README.md; docker-compose.aws.yml (single-EC2-host SFTP-pilot path only).
- engine/Dockerfile; engine/package.json.
- .github/workflows/ci.yml and codeql.yml.
- docs/PRODUCTION_READINESS.md.

## Exceptions and review

- Exceptions require documented business justification, risk assessment, compensating controls, expiration date, and written approval from the Security Officer and affected System Owner. This document must be reviewed before production adoption and after material changes to technology, vendors, data use, or law.

## Authority and references

- 45 CFR Parts 160 and 164, including the HIPAA Privacy, Security, and Breach Notification Rules.
- HHS OCR, Security Rule Guidance Material: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html
- HHS OCR, Guidance on Risk Analysis: https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- HHS OCR, Business Associate Contract Requirements: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
