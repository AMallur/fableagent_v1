# Integration readiness

This document defines the boundary between what FableAgent can make complete in code and what must be supplied or verified during a real customer/cloud integration.

## Principle

Business logic must not depend directly on a particular customer's credentials or on the existence of a live AWS resource. Code defines interfaces, schemas, validation gates, Terraform, and safe defaults. Deployment supplies identifiers, secrets, customer data, and partner certifications.

A production integration should therefore be a configuration-and-validation exercise, not a rewrite of the application.

## Client/payer configuration model

Existing clients remain backward-compatible when migration `0024_client_payer_readiness.sql` is applied. The normal application `createClient()` path creates a client with its BAA acknowledgment in the initial insert; the database marks that client `require_payer_activation = true`. Dev/demo/legacy inserts that do not carry a BAA at creation remain nonblocking unless an operator explicitly enables the gate. Each new `client_payer_config` starts in `draft` with detection and appeals disabled.

Lifecycle:

`draft -> validation_pending -> validated -> active`

An active profile may later move to `suspended` or `retired`. Unsafe jumps such as `draft -> active` are rejected by the application readiness helper.

Each profile has independently gated capabilities:

- detection
- appeal generation/workflow
- electronic submission

The detection snapshot, appeal generation service, and electronic submission dispatcher all enforce the database capability gate. Electronic submission is deliberately the strongest gate: a payer can be usable for shadow detection and reviewed recovery while electronic transmission remains disabled.

## Standard payer implementation package

For each client/payer pair, implementation should collect and version:

1. Payer identity
   - canonical payer record
   - electronic payer ID
   - client-specific EDI aliases/trading-partner identifiers
2. Contract/pricing
   - effective/expiration dates
   - fee schedule or percent-of-Medicare rules supported by the engine
   - source checksum/provenance
   - CMS locality/reference dataset where applicable
3. Workflow
   - timely filing limit
   - appeal deadline
   - portal/appeal address
   - minimum case threshold
   - manual-review threshold
   - autopilot/electronic-submission switches
4. Validation evidence
   - 835 parsing
   - 837P parsing when used
   - payer mapping
   - contract pricing
   - historical adjudicated claims
   - appeal rules
   - reference data
   - submission route
5. Approval
   - validator
   - activation operator
   - validation/activation timestamps
   - notes and version

The `client_payer_alias`, `client_payer_validation`, and `client_payer_compatibility` objects introduced in migration 0024 are the canonical database surfaces for this package.

## Validation expectations

A production-ready detection profile should normally have passed:

- payer mapping validation
- 835 validation
- pricing validation against adjudicated examples
- reference-data validation

Contract-priced payers also need an active approved contract. Medicare/reference-priced profiles still need comparison against known adjudications; choosing a public fee schedule is not itself validation.

Appeals additionally need appeal-rule validation. Electronic submission additionally needs end-to-end submission-route validation and an explicit enable flag.

Validation evidence belongs in `client_payer_validation.metrics` and `client_payer_validation.evidence`. Avoid storing raw PHI there; store internal IDs, aggregate metrics, source checksums, and document references instead.

## Compatibility matrix

`client_payer_compatibility` exposes one RLS-preserving view for admin/API/UI surfaces. It reports the payer, configuration version/status, enabled capabilities, contract presence, and key validation states.

Use `engine/src/integration/readiness.ts` for the pure capability decision. The same evaluator should drive UI badges, activation checks, and service-side enforcement so the rules do not diverge.

## Runtime integration preflight

`engine/src/integration/runtime_readiness.ts` is side-effect free. It checks whether the environment has the values required for:

- application startup
- PHI-capable durable document storage
- email delivery
- Optum/Change Healthcare live submission

It does not claim that a configured external service is actually reachable or certified. Live connectivity, BAA coverage, credentials, DNS, certificates, and partner certification remain external gates.

## PHI-safe logging

`engine/src/security/logging.ts` provides the canonical structured-log redaction layer. Operational logs should use internal UUIDs/correlation IDs instead of patient/member data. Raw X12, patient/member identifiers, diagnosis fields, authorization values, credentials, and long payloads are redacted or fingerprinted before serialization.

Detection and appeal job failures now use this sanitizer before persisting error detail. New code that emits operational logs should use the same layer rather than interpolating request/EDI objects directly.

## AWS code-ready controls

The Terraform stack now includes definitions for:

- object-level CloudTrail S3 data events on the document bucket
- stronger Config checks for public S3 write, public RDS, Multi-AZ RDS, and multi-region CloudTrail
- optional AWS WAF managed rules and per-IP rate limiting
- WAF log redaction for authorization/cookie/API-key headers
- optional interface VPC endpoints for ECR, Secrets Manager, CloudWatch Logs, KMS, and STS
- additional ALB/RDS operational alarms

The WAF and interface endpoints are opt-in variables because applying them has real AWS cost and should happen deliberately:

- `enable_edge_waf = true`
- `enable_interface_endpoints = true`

Committing Terraform creates no AWS resource and incurs no AWS charge. `terraform apply` does.

## Inputs that cannot be completed in source code

The following must be supplied or performed in the actual environment:

- AWS BAA/account/organization decisions
- DNS and ACM validation
- actual RDS/S3/KMS/Secrets Manager/ECS resources
- real secret values and key rotation execution
- customer TIN/NPI/location/provider data
- customer contracts and fee schedules
- real payer IDs/aliases observed in customer EDI
- historical adjudicated claims for validation
- clearinghouse credentials and certification
- BAA-covered SMTP provider configuration
- production backup/restore and DR exercises
- penetration/security testing against the deployed environment
- customer security review evidence and organizational HIPAA processes

## Activation rule

Do not equate "the code path exists" with "the payer is production ready."

A safe rollout is:

1. create client
2. discover/map payers from sample EDI
3. create payer profiles in draft
4. load/approve contracts and reference data
5. run historical validation
6. record validation evidence
7. activate detection in shadow mode
8. validate findings with the customer
9. enable appeal workflow
10. certify the outbound route
11. explicitly enable electronic submission

This keeps the same application code from local development through a commercial pilot while making customer-specific risk explicit and auditable.
