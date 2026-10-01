# Legal, security, and commercial sourcing guide

This is a practical map of the non-code requirements for running this platform
against real PHI and real claims: for each item, who actually provides it,
whether a first draft can be produced directly, and what this codebase already
does or doesn't cover. It complements
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md), which lists the release
gates from the code side; this document covers the business/legal/commercial
side referenced there (gate 1: BAAs; gate 8: HIPAA program).

**This is not legal advice, and nothing here substitutes for review by a
licensed healthcare attorney before live PHI or live claims move through the
system.** Treat every "draftable now" item below as a first draft for counsel
to mark up, not a finished, signable document.

Legend used throughout:

| Tag | Meaning |
|---|---|
| 🖊️ Draftable now | A first draft can be produced directly (contract language, policy text, risk-analysis template). Still requires attorney/expert review before use. |
| ⚖️ Attorney only | Jurisdiction-specific, liability-bearing, or requires a bar license to finalize (e.g., filing, opinion letters, negotiated risk allocation). A draft can inform the conversation but shouldn't be the final artifact. |
| 🏦 External vendor | Only a specific carrier, auditor, or counterparty can issue this (insurance policy, SOC 2 report, clearinghouse contract). |
| 🏛️ Government/payer filing | Goes through a state agency, federal registry, or payer's own enrollment process. No amount of drafting substitutes for the filing. |
| ✅ In this codebase | Already implemented — cited to the specific mechanism. |

---

## 1. Company and customer contracts

| Item | Sourcing | Notes |
|---|---|---|
| Legal entity (LLC/corp) formation | 🏛️ State filing (Texas Secretary of State, or Delaware + TX foreign qualification) | Needs a registered agent and an EIN from the IRS. A formation attorney or a service like a business-formation firm typically handles this in days; it's cheap and fast, but it's still a filing you don't want to DIY-and-hope. |
| MSA, subscription/license agreement, SLA, AUP/support terms | 🖊️ Draftable now | These are standard SaaS commercial terms. A first draft covering scope of service, fees, term/termination, uptime commitments, support tiers, and liability caps can be produced directly from how this platform actually operates (see the service list and automation behavior in the main [README](../README.md)). |
| BAA (with each clinic/provider) | 🖊️ Draftable now, ⚖️ attorney review required | HHS publishes [sample BAA provisions](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html) that are a legitimate starting skeleton. A draft can be built from those provisions tailored to what this platform actually does (ingest 835/837, generate appeal packets, store documents, run detection) — but permitted-use scope, breach-notice timelines, and liability allocation are exactly the terms attorneys negotiate, so this one should not go out the door without review. |
| Data Processing/Security Addendum | 🖊️ Draftable now | Can be drafted directly from the actual technical controls in the codebase (encryption, RBAC, audit logging — see §4) so it's not full of unverifiable claims. |
| Scope-of-service clause (software-only vs. billing/coding/collections) | 🖊️ Draftable now, ⚖️ recommend attorney sign-off | This is a business decision as much as a legal one — you decide what the platform does (this codebase is decision-support: detection + draft appeal generation, human/clearinghouse submits — see `appeals/service.ts` and the `needs_review` routing in the README) and counsel turns that into liability-limiting contract language. |
| Downstream BAAs with cloud/software vendors (hosting, email, storage) | 🖊️ Draftable now for the request, 🏦 the vendor issues their own paper | Most major cloud/SMTP/storage vendors have a standard BAA they'll countersign once you're on a paid/enterprise tier. This is item 1 in `PRODUCTION_READINESS.md`'s "Required external gates" — it must be done before any real PHI reaches those services, and the doc there already names which services need one (hosting, storage/GCS, SMTP). |

## 2. HIPAA compliance program

| Item | Sourcing | Notes |
|---|---|---|
| Privacy Rule / Security Rule / Breach Notification Rule policies | 🖊️ Draftable now | A full policy set (minimum-necessary access, workforce training curriculum, sanctions policy, designated Security/Privacy Officer roles, retention schedule) can be drafted directly, scoped to what this platform actually does — most generic templates aren't. |
| Workforce HIPAA training | 🖊️ Draftable now (curriculum/slides), delivery is on you | Content can be produced; running it and keeping attendance records is an operational task, not a document. |
| Designated Security & Privacy Officer | Internal decision — no external sourcing needed | Just needs a named person and it documented. |
| Direct BA liability under HIPAA | N/A — this is a legal fact, not a deliverable | Business associates are directly liable for Security Rule compliance, not just contractually liable to the covered entity. The compliance program above is what keeps you on the right side of that. |

## 3. Formal security risk analysis

| Item | Sourcing | Notes |
|---|---|---|
| Risk analysis template & methodology | 🖊️ Draftable now | HHS's risk-analysis guidance gives the required structure (asset inventory, threat/vulnerability assessment, risk ratings, remediation plan, reassessment cadence). |
| PHI data-flow diagram | 🖊️ Draftable now, from the actual codebase | This is one of the few items where the code itself is the source of truth: PHI flows in via SFTP drop / manual upload / public API (`src/integration/`), through ingest → detection → appeal generation, out via document storage and outbound connectors (`src/integration/connectors.ts`). A diagram built from that is accurate rather than generic. |
| Vendor-risk reviews | 🖊️ Draftable now (questionnaire + tracking template); running it against real vendors is on you | |
| Disaster-recovery / business-continuity plan | 🖊️ Draftable now as a plan; ⚖️/🏦 actually running failover, backup/restore, and load tests requires your real infrastructure | `PRODUCTION_READINESS.md` already flags this as required-gate #7 — the plan can be written, but the exercise itself has to happen against the live deployment. |

## 4. Technical safeguards

Most of this list is already implemented rather than something to "get" — worth checking against what exists before assuming a gap:

| Requirement | Status |
|---|---|
| Encryption in transit | ✅ `FORCE_HTTPS`/TLS termination via Caddy (`Caddyfile`), mandatory HTTPS in production (`requireHttps()`, `src/web/server.ts`) |
| Encryption at rest | ✅ Relies on storage-level encryption (TDE/encrypted volumes) — a deliberate choice documented in the README; AES-256-GCM for SFTP credentials and MFA secrets specifically (`DATA_ENCRYPTION_KEY`) |
| Unique user identities / RBAC | ✅ Tenant/client-scoped users, role scoping, forced RLS (README §"Enterprise administration & security") |
| MFA | ✅ TOTP (RFC 6238) enforced for admin roles when `tenant.enforce_mfa` is on |
| Audit logs | ✅ Append-only `audit_log` (DB trigger blocks UPDATE/DELETE), `phi_accessed` rows via a SECURITY DEFINER function, `/compliance` portal |
| Session expiration | ✅ 30-min default, sliding renewal, signed cookies with 12h TTL |
| Secrets management | ✅ `SESSION_SECRET`/`DATA_ENCRYPTION_KEY` required in production, `${NAME}_FILE` convention for mounted secrets |
| Backups / DR | 🏦 Depends on your managed Postgres provider's config — the README explicitly states this repo does not provision the managed instance itself |
| Vulnerability/patch management | ✅ Partial — `npm audit` and CodeQL gates in CI (`PRODUCTION_READINESS.md`); 🏦 infra-level patching depends on your host |
| Environment separation | Operational decision — docker-compose gives you the shape, but staging vs. prod is on your deployment practice |
| Secure SDLC | ✅ Partial — CI gates (tests, RLS suite, CodeQL, npm audit) exist; 🖊️ a written SDLC policy documenting this can be drafted |
| No PHI in logs/analytics | ⚠️ Needs verification, not assumed — worth an explicit grep/audit pass over logging call sites before go-live |

Everything marked 🏦 or ⚠️ above is the actual gap list — not the fully-built items.

## 5. Incident-response and breach plan

| Item | Sourcing |
|---|---|
| Written IR plan (detection, containment, evidence preservation, PHI-compromise assessment, notification workflow, corrective action) | 🖊️ Draftable now — can be built directly against this platform's actual audit trail and alerting mechanisms (`audit_log`, `phi_accessed`, notification center) so containment/detection steps reference real tooling rather than generic ones |
| Breach-notification timelines | ⚖️ Attorney should confirm — HIPAA's own floor is "without unreasonable delay, no later than 60 days," but customer contracts routinely demand 24–72 hours, and Texas overlays its own timeline (see §11) |
| Tabletop exercises | Operational — can draft the scenario/script, but running it is on your team |

## 6. Clearinghouse agreement (Optum or similar)

🏦 **External vendor, no way around it.** A production services contract,
BAA, transaction-pricing agreement, and trading-partner registration all come
directly from the clearinghouse — Optum will not accept a template from
anyone else. What can be prepared in advance:

- 🖊️ A technical/integration questionnaire response describing this
  platform's connector model (`src/integration/connectors.ts`'s
  `OutboundConnector` registry, currently shipped in `not_configured` status
  per `PRODUCTION_READINESS.md` gate #4) — clearinghouses ask exactly this
  during onboarding.
- ⚖️ Confirm the contract's language actually permits your integration model
  (platform-submits-on-behalf-of-provider vs. provider-owns-credentials) —
  this is the specific trap the task description calls out, and it's a
  contract-interpretation question for counsel, not something to assume.

## 7. Provider authorization and payer enrollment

🏛️ **Government/payer filings, tracked by your platform but not issued by
it.** NPI (NPPES registry), EDI trading-partner enrollment, ERA/EFT
enrollment, and Medicare EDI agreements belong to the provider and are filed
with each payer/CMS directly — no software shortcut exists. What this
platform can do:

- ✅ Already tracks per-payer configuration (filing method, deadlines, portal
  vs. clearinghouse) per the README's client administration section.
- 🖊️ A signed-provider-authorization template (the document a clinic signs
  authorizing your platform to submit on their behalf) is draftable now,
  but should be attorney-reviewed alongside the BAA since it interacts with
  the scope-of-service question in §1.

## 8. HIPAA transaction standards (X12)

Largely a code-correctness question rather than a document to source:

| Transaction | Status here |
|---|---|
| 837P (claims) | ✅ Implemented — `engine/src/ingest/parse837.ts` |
| 835 (remittance) | ✅ Implemented — `engine/src/ingest/parse835.ts` |
| 837I, 270/271, 276/277, 278, 999, 277CA, TA1 | ❌ Not implemented — `PRODUCTION_READINESS.md` explicitly scopes initial production to 835/837P only and says institutional claims and other transaction sets "must not be represented as supported" until built |

Companion-guide compliance per payer is a validation task (gate #5 in
`PRODUCTION_READINESS.md`: "Validate each supported payer contract model
against adjudicated examples") — this is real engineering work against real
payer test files, not a document to acquire.

## 9. Coding and billing compliance

| Item | Sourcing |
|---|---|
| CPT/HCPCS license | 🏦 AMA (CPT) licensing is a paid, direct license — required if the platform displays or processes CPT codes commercially |
| NCCI edits, medical-necessity rules | 🏦/🖊️ Public CMS data feeds the ruleset; loading and maintaining it is engineering work |
| Human review of coding recommendations, audit trail of approvals | ✅ Already structural — `needs_review` routing beats autopilot for medical necessity, low confidence, or no prior payer history (README "Routing"); `corrected_claim` stores original+corrected fields, confidence, and flags anything under 85 `needs_manual_review` — the claim itself is never mutated by the generator |
| "Provider remains responsible for final claim accuracy" contract clause | 🖊️ Draftable now — this is exactly the scope-of-service language from §1, and it's consistent with how the engine is actually built (decision support, not autonomous billing) |

## 10. Data ownership and patient rights

| Item | Sourcing |
|---|---|
| Ownership/retention/deletion/de-identification terms | 🖊️ Draftable now, as part of the MSA/DPA in §1 |
| Restriction on PHI use for model training / unrelated product development | 🖊️ Draftable now — a BAA does not implicitly grant this right, so it needs its own explicit clause if you ever want to use de-identified data for analytics or ML |
| Patient access/amendment/accounting-of-disclosures support | ✅ Partially structural — `/compliance` portal's PHI access log and audit trail support producing an accounting of disclosures; the access/amendment *workflow* itself (a patient-facing request process) is not currently a feature and would need to be built or handled procedurally by the covered entity |

## 11. State privacy laws (Texas, then wherever you expand)

⚖️ **Attorney territory.** The Texas Medical Records Privacy Act and Texas
breach-notification statute impose obligations beyond baseline HIPAA
(narrower consent exceptions, stricter/faster notification timing in some
cases, TX Attorney General enforcement). This needs a Texas healthcare
privacy attorney's sign-off specifically — it's genuinely stricter than
federal law in places, and "we're HIPAA compliant" is not the same claim as
"we're Texas-compliant." As you add states, this review repeats per
jurisdiction (California, Illinois, and a growing list of states have their
own health-data statutes beyond HIPAA).

## 12. Insurance

🏦 **External carrier, not draftable.** Cyber liability, tech E&O, general
liability, and possibly crime/social-engineering coverage all come from an
insurance broker who places healthcare-tech policies. What can be prepared:

- 🖊️ A one-page risk summary (what data you handle, scale, architecture,
  existing controls from §4) to hand a broker — this speeds up underwriting
  and can be produced directly from the codebase's actual security posture.
- Enterprise customers will ask for specific limits and additional-insured
  status; that's a negotiation with the broker once you know your first few
  customers' contractual asks.

## 13. Security validation customers may request

| Item | Sourcing |
|---|---|
| SOC 2 Type II / HITRUST | 🏦 Independent auditor engagement — months-long process, not something to draft your way into. Worth deferring until post-pilot per the task description's own framing. |
| Penetration test | 🏦 External pentest firm | The existing CodeQL/`npm audit` CI gates are necessary but not a substitute for one. |
| Security questionnaire responses | 🖊️ Draftable now, directly from §4's actual control list — this is the one item here that's mostly just describing what's true. |
| Subprocessor list | 🖊️ Draftable now once your vendor stack (hosting, SMTP, storage, clearinghouse) is finalized |
| Background-check evidence, BC/DR test evidence | Operational — process to run, not a document to acquire |

---

## What this means for a first pilot

Mapping the task description's "minimum package" against sourcing:

| # | Item | Owner |
|---|---|---|
| 1 | Registered company + insurance | 🏛️ state filing + 🏦 broker |
| 2 | MSA/BAA/SLA/security addendum | 🖊️ draft now → ⚖️ attorney finalize |
| 3 | Vendor BAAs (hosting/storage/SMTP) | 🏦 vendor paper, gate #1 in `PRODUCTION_READINESS.md` |
| 4 | HIPAA risk analysis + policies | 🖊️ draft now, tailored to this codebase |
| 5 | Secure architecture + audit logging | ✅ largely built — see §4 table for the real gaps |
| 6 | Incident-response/breach plan | 🖊️ draft now → ⚖️ attorney confirms notification timelines |
| 7 | Optum production contract | 🏦 vendor-only, confirm integration model is permitted |
| 8 | Provider authorization + EDI/payer enrollment | 🏛️ filed per-provider, tracked by the platform |
| 9 | X12 validation + acknowledgment processing | Engineering work against gate #5; 999/277CA/TA1 not yet built |
| 10 | Coding/claim-approval/audit controls | ✅ largely built (`needs_review`, confidence thresholds) — human review is procedural on top |
| 11 | Texas privacy-law review | ⚖️ attorney, Texas-specific |
| 12 | Healthcare attorney review before live claims | ⚖️ non-negotiable, final gate |

The sandbox/synthetic-data phase (Optum test data, no real PHI) doesn't need
most of this — it becomes necessary once real patients, real provider
credentials, real claims, or real payer connections enter the picture, which
matches how `PRODUCTION_READINESS.md` already frames "required external
gates" versus what's automated in CI today.

If useful, the 🖊️ "draftable now" items above (MSA, BAA skeleton, DPA, IR
plan, risk-analysis template, security-questionnaire responses,
provider-authorization form) can be produced as actual draft documents on
request — each would still need a licensed healthcare attorney's review
before use with a real customer.
