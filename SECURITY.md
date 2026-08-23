# Security policy

FableAgent handles security-sensitive revenue-cycle workflows. Please do not disclose a suspected vulnerability publicly before it has been reviewed and remediated.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting / Security Advisory mechanism for this repository when available. Include:

- affected component and version/commit;
- reproduction steps or proof of concept;
- security impact;
- whether regulated or customer data could be exposed;
- prerequisite access/permissions; and
- any suggested remediation.

Do not include real customer data, credentials, access tokens, or other secrets in the report. Use synthetic examples where possible.

If private GitHub reporting is not available, contact the repository owner through a private channel before publishing details rather than opening a public issue containing exploit information or sensitive data.

## Supported version

Until formal release channels are established, only the current production-designated commit is supported for security fixes. Pilot/customer release records must identify the exact supported commit and image digest.

## Security response expectations

Reported issues are triaged by severity and exploitability. A critical or high issue affecting tenant isolation, authentication, authorization, secrets, audit integrity, regulated-data exposure, or unauthorized external actions is a live-release blocker unless it is remediated or formally risk-accepted by the accountable customer/operator where such acceptance is appropriate.

Security fixes should include regression coverage whenever the behavior can be tested automatically. Production releases should retain the relevant CI, dependency-audit, static-analysis, deployment, and external security evidence described in `docs/COMMERCIAL_ASSURANCE_MATRIX.md`.

## Safe-harbor intent

Good-faith security research that avoids privacy violations, destructive testing, service disruption, social engineering, and access to data beyond what is necessary to demonstrate the issue is welcomed. This repository cannot grant permission to test customer, payer, clearinghouse, cloud-provider, or other third-party systems.
