# Commercial assurance evidence matrix

This document is the release evidence index for FableAgent. It distinguishes controls that can be demonstrated by the repository and deployment from claims that require an independent customer, assessor, trading partner, insurer, attorney, or auditor.

A control is not considered externally validated merely because documentation exists. Evidence must be current, attributable, reproducible where possible, and tied to the deployed version.

## Evidence classes

| Class | Meaning | Examples |
|---|---|---|
| A — automated | Reproducible repository or CI evidence | unit/integration/RLS tests, dependency audit, image build, Terraform validation |
| B — deployment | Evidence generated in the target environment | backup restore, load test, failover test, logging/alert exercise |
| C — customer validation | Independent domain review using customer data | contract-rate accuracy, finding precision, recovered dollars |
| D — third party | Attestation or approval that FableAgent cannot self-issue | BAA, penetration test, SOC report, clearinghouse certification, insurance |

## Commercial release controls

| Control | Required evidence | Class | Repository status | External dependency |
|---|---|---:|---|---|
| Unit regression safety | Passing `npm test` on release commit | A | implemented | none |
| Full PostgreSQL workflow | Passing `npm run test:integration` | A | implemented | none |
| Tenant isolation | Passing non-superuser RLS suite | A | implemented | independent penetration test recommended |
| Dependency vulnerability gate | `npm audit --omit=dev --audit-level=high` passes | A | implemented in CI | independent review recommended |
| Static security analysis | CodeQL passes on release commit | A | implemented | none |
| Runtime image reproducibility | Docker build succeeds from release commit | A | implemented in CI | registry/signing policy for deployment |
| Infrastructure syntax | Terraform validation succeeds | A | implemented in CI | target-account configuration evidence |
| Secrets fail-closed behavior | Production boot rejects missing required secrets | A | implemented | target secret manager configuration |
| HTTPS enforcement | Production runtime forces HTTPS and secure session handling | A/B | implemented | TLS edge configuration evidence |
| Audit integrity | Append-only audit controls plus regression tests | A/B | implemented | retention/export verification |
| Backup/restore | Timestamped restore exercise with RPO/RTO result | B | procedure required per deployment | cloud target and operator |
| Disaster recovery | Documented failover exercise against declared RTO/RPO | B | procedure required per deployment | cloud target and operator |
| Load/capacity | Repeatable workload test with saturation and error thresholds | B | target-specific | target infrastructure |
| Contract pricing validity | Customer contract owner signs a sample comparison against executed terms | C | workflow documented | customer contracting SME |
| Finding precision | Frozen, independently adjudicated real-data validation | C | protocol documented | customer data and RCM reviewer |
| Finding recall | Complete blinded ground-truth sweep on a defined sample | C | protocol documented | customer data and RCM reviewer |
| Dollar accuracy | Predicted opportunity compared with independently validated payer liability | C | protocol documented | customer data and contract evidence |
| Recovered revenue | New post-action cash reconciled to submitted cases | C | tracking supported | payer outcome and mature window |
| Corrected-claim safety | Qualified coding review for every correction in initial scope | C | required release gate | qualified coding reviewer |
| Live outbound delivery | Idempotency, acknowledgement, rejection, retry and reconciliation certification | C/D | connector interface only | clearinghouse/payer trading partner |
| HIPAA organizational program | Adopted policies, risk analysis, training, incident response, access review | B/D | draft materials present | covered organization/business associate |
| BAAs / DPA | Executed agreements for relevant services and customer | D | templates/checklist only | counterparties and counsel |
| CPT/content rights | Current required licenses | D | integration boundary documented | licensor |
| Independent penetration test | Final report plus remediation evidence | D | not self-attestable | independent security firm |
| SOC 2 or equivalent attestation | Auditor-issued report if commercially required | D | not self-attestable | licensed audit firm |
| Cyber/E&O insurance | Active policy and certificate if contractually required | D | not self-attestable | insurer/broker |

## Release rule

No document, test fixture, synthetic benchmark, self-review, or internally generated report may be represented as independent real-world validation.

A production release packet must identify:

1. exact Git commit and container/image digest;
2. CI run and required passing automated gates;
3. deployed environment and infrastructure version;
4. applicable customer/pilot scope and exclusions;
5. current reference/contract data versions;
6. unresolved known risks and owner;
7. evidence for every Class B control in scope;
8. evidence for every Class C/D control required by the customer contract; and
9. explicit approval by the accountable release owner.

If required evidence is absent or stale, the control is **not verified**. The release packet must not infer compliance or validation from implementation alone.
