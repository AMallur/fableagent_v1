# FableAgent assurance index

This is the starting point for customer security, technical diligence, pilot validation, and release review. It separates evidence the repository can generate reproducibly from evidence that must come from a deployed environment, customer reviewer, trading partner, or independent third party.

## Repository-generated evidence

| Question | Evidence |
|---|---|
| What is allowed at each commercial stage? | `OPERATIONAL_ACCEPTANCE_GATES.md` |
| Which controls are automated vs external? | `COMMERCIAL_ASSURANCE_MATRIX.md` |
| What are the production release blockers? | `PRODUCTION_READINESS.md` |
| What threats and trust boundaries are recognized? | `SECURITY_THREAT_MODEL.md` and root `SECURITY.md` |
| How are backup, restore, failover, outage, and load exercises run? | `OPERATIONAL_RESILIENCE_RUNBOOK.md` |
| How is a real-world RCM study designed? | `EXTERNAL_VALIDATION_PROTOCOL.md` |
| What evidence must a pilot retain? | `PILOT_EVIDENCE.md` and `PILOT_RUNBOOK.md` |
| What does a customer-facing release packet contain? | `RELEASE_EVIDENCE_TEMPLATE.md` |
| How are external reference datasets controlled? | `REFERENCE_DATA.md` |
| Where are HIPAA-oriented policies/control mappings? | `../compliance/` and `../compliance/technical_standards/` |

## Reproducible commands

From `engine/`:

```sh
npm test
npm run test:integration
npm run test:rls
npm run benchmark:pilot
npm run validation:external -- --input ../docs/examples/external_validation.example.json
npm run evidence:manifest -- --help
npm audit --omit=dev --audit-level=high
npm sbom --sbom-format=cyclonedx
```

The PR CI additionally builds runtime images, validates Terraform, executes CodeQL through its dedicated workflow, retains the deterministic synthetic benchmark/evidence smoke outputs, and stores dependency-audit/SBOM artifacts tied to the commit SHA.

## Evidence hierarchy

1. **Automated repository evidence** — tests, RLS regression, dependency audit, CodeQL, container builds, deterministic benchmark/evidence tooling.
2. **Deployment evidence** — actual cloud IAM/KMS/TLS configuration, restore/failover/load exercises, monitoring/alerting, production role grants.
3. **Customer/domain evidence** — real contract validation, blinded finding adjudication, precision/recall, coding review, post-action payment reconciliation.
4. **Independent/third-party evidence** — BAAs, penetration test, SOC report if required, insurance, content licenses, clearinghouse/payer certification.

A lower evidence class cannot substitute for a higher one. In particular, passing CI does not establish HIPAA compliance, customer validation, payer certification, or recovered revenue.

## External-validation safeguards

The external validation tooling is intentionally conservative:

- duplicate and already-recovered findings count against finding precision;
- unresolved findings are reported and cannot silently disappear;
- recall and dollar recall are unavailable without a declared complete ground-truth sweep;
- dollar precision/recall use matched validated dollars (`min(predicted, validated)` per true positive), keeping the metrics bounded and penalizing both overstatement and underestimation;
- source/reviewer input and evidence bundles are SHA-256 fingerprinted; and
- identified, submitted, approved, and recovered dollars remain distinct concepts.

## What is still external

Before a live-PHI production deployment, the accountable operator/customer still needs the applicable executed BAAs and agreements, target-environment security configuration, backup/restore evidence, independent penetration testing appropriate to the deployment, qualified coding/RCM review, current licensed reference content, and certified/accepted trading-partner integrations. Real-world performance claims require real customer data and independent human adjudication; recovered-revenue claims require reconciled post-action cash.
