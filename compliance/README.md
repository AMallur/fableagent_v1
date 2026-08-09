# HIPAA Compliance Program

This directory is FableAgent's organizational HIPAA compliance
documentation — the piece explicitly called out as *not* establishable by
the application code itself
(`docs/PRODUCTION_READINESS.md`, required external gate 8: "Complete the
organizational HIPAA risk analysis, policies, workforce training, incident
response plan and access-review process").

An executed AWS Business Associate Addendum is necessary but not
sufficient for HIPAA compliance — it covers AWS as a subprocessor, not the
Company's own compliance program. This directory is that program.

## Contents

| File | Citation | Status |
|---|---|---|
| `security_officer_designation.md` | §164.308(a)(2) | **Fill in name/date and sign** |
| `risk_analysis.md` | §164.308(a)(1)(ii)(A) | Drafted against the actual current architecture — **review and date it** |
| `policies/access_control_policy.md` | §164.308(a)(3)–(4), §164.312(a) | Drafted, ready to adopt |
| `policies/encryption_policy.md` | §164.312(a)(2)(iv), §164.312(e) | Drafted, ready to adopt |
| `policies/incident_response_and_breach_notification_policy.md` | §164.308(a)(6), §§164.400–414 | Drafted, ready to adopt |
| `policies/workforce_sanction_policy.md` | §164.308(a)(1)(ii)(C) | Drafted, ready to adopt |
| `policies/device_and_media_controls_policy.md` | §164.310(d) | Drafted, ready to adopt |
| `policies/security_awareness_training_policy.md` | §164.308(a)(5) | Drafted — **then actually complete training, see below** |
| `policies/vendor_baa_management_policy.md` | §164.308(b), §164.502(e) | Drafted, ready to adopt |
| `workforce_training_log.csv` | §164.308(a)(5) | Template — **empty until you complete a course** |
| `baa_template.md` | §164.308(b) | Draft only — **requires attorney review before use with a real client** |

## Technical and operational standards (`technical_standards/`)

A second, complementary layer of documentation: engineering-specific
technical/operational standards, rather than the administrative-safeguards
policies above. These cover things a security review or an enterprise
client's vendor-security questionnaire will actually ask about — tenant
isolation, secrets rotation, session management, SDLC gates, audit event
structure, AI/LLM data-use restrictions — with citations back to the actual
implementing code and Terraform, not generic policy language.

| File | Covers | Status vs. actual implementation |
|---|---|---|
| `00_Master_Document_Register.md` | Index and approval record for this whole package | Fill in officer names and approval dates |
| `01_PHI_Data_Flow_Diagram.md` | Where PHI enters/moves/leaves the system | Drafted against actual data flows |
| `02_Application_and_Cloud_Architecture.md` | Production topology and security zones | Corrected to AWS (was originally drafted assuming GCP — see note below) |
| `03_HIPAA_System_Boundary_Definition.md` | What's in vs. out of the HIPAA-covered system | Drafted |
| `04_Control_to_Code_Traceability_Matrix.md` | Maps HIPAA safeguards to actual code/tests | Drafted, cites real files |
| `05_Risk_Register_and_Remediation_Tracker.md` | Live, ID-tracked risk items | Reconciled with `risk_analysis.md` — see cross-reference note in both |
| `06_Cloud_Shared_Responsibility_Matrix.md` | What AWS owns vs. what FableAgent owns | Corrected to AWS |
| `07_Approved_HIPAA_Eligible_Cloud_Services_List.md` | Per-service PHI approval register | Corrected to AWS; several services already implemented in Terraform, marked accordingly |
| `08_Vendor_Subprocessor_Register_and_BAA_Tracker.md` | Per-vendor tracked register | Reconciled with `policies/vendor_baa_management_policy.md` — see cross-reference note in both |
| `09_MFA_Configuration_Standard.md` | MFA requirements | TOTP MFA is genuinely implemented (`engine/src/web/auth.ts`) |
| `10_Role_and_Permission_Matrix.md` | Minimum-necessary access | Drafted |
| `11_Tenant_Isolation_Specification.md` | Cross-tenant PHI separation | RLS is genuinely implemented and matches this spec closely |
| `12_Production_Access_Procedure.md` | Privileged access request/approval/removal | Drafted, mostly organizational process |
| `13_Session_Management_Standard.md` | Session cookie/timeout requirements | Foundation implemented (HttpOnly/SameSite); verify against the 30-minute timeout requirement |
| `14_Secrets_and_Encryption_Key_Management_Procedure.md` | Secret/key lifecycle | Largely implemented (Secrets Manager, KMS); rotation schedule still to formalize |
| `15_Secure_Software_Development_Lifecycle.md` | Security gates in the dev lifecycle | Drafted |
| `16_Code_Review_and_Deployment_Approval_Procedure.md` | Review/deploy controls | CI gates exist; branch-protection enforcement of "no unreviewed changes" not yet confirmed |
| `17_Dependency_Container_and_Infrastructure_Scanning_Standard.md` | Required security scanning | `npm audit`/CodeQL run in CI; container and IaC scanning (Trivy/Checkov) are real gaps, not yet implemented |
| `18_Environment_Separation_Standard.md` | Dev/test/staging/prod isolation | Local vs. AWS separation exists; separate per-environment AWS accounts do not yet |
| `19_Audit_Event_Specification.md` | Required audit event fields | An audit/job-tracking schema exists (`0007_audit_and_jobs.sql`); verify field-by-field coverage |
| `20_PHI_Safe_Logging_Standard.md` | Permitted telemetry content | Genuinely implemented (`engine/src/security/logging.ts`) |
| `21_Backup_Restoration_Test_Procedure.md` | Verified recovery, not just backup config | Backup/encryption config implemented; the actual restore test has never been run |
| `22_AI_LLM_PHI_Use_and_Model_Training_Restrictions.md` | Governs AI/LLM use with PHI | **Read this one now** — it governs how AI tools (including Claude, working in this repo) may be used once real PHI exists |
| `23_Data_Retention_Schedule_by_Category.md` | Retention/disposal by data category | Drafted |
| `24_Incident_Contact_and_Notification_Matrix.md` | Escalation contacts/deadlines | Extends `policies/incident_response_and_breach_notification_policy.md` with a concrete contact matrix — fill in real names/numbers |
| `25_Texas_Privacy_and_Breach_Law_Addendum.md` | Texas-specific overlay | Only relevant if the Company or its customers are Texas-based — confirm applicability, then get counsel review regardless |
| `26_Penetration_Test_Remediation_Procedure.md` | Pentest finding triage/closure | Relevant once a pentest is actually scheduled; no pentest has been run yet |
| `27_Customer_Termination_and_PHI_Return_Procedure.md` | PHI return/destruction at offboarding | Drafted |

**About the AWS/GCP correction:** documents 02, 06, and 07 were originally
drafted assuming Google Cloud as the production platform, inferred from
this repo's cloud-agnostic storage code (`docker-compose.cloudsql.yml`,
`gcs_document_store.test.ts`) rather than from the actual deployment
target. The real, fully-built Terraform infrastructure in this repo is
**AWS only** (`infra/aws/terraform/`) — those three documents have been
corrected accordingly, along with GCP references in the risk register (05)
and vendor register (08).

## What you still need to actually do (this repo can't do it for you)

1. **Fill in the brackets.** Every `[DATE]`, `[YOUR NAME]`,
   `[COMPANY LEGAL NAME]` placeholder needs a real value before these are
   adopted documents rather than drafts.
2. **Sign the Security Officer designation.** One paragraph, takes two
   minutes once you've formed a legal entity.
3. **Take a HIPAA security-awareness training course** and log it in
   `workforce_training_log.csv`. Cheapest paths: a $20-50 one-time course
   (HIPAA Exams, MedTrainer, Compliancy Group), or bundled into a
   compliance-automation platform subscription if you get one (see below).
4. **Get the BAA template reviewed by an attorney** before you send it to
   any real client — this is the one document here worth paying a lawyer
   for, since it's the Company's actual liability exposure, not an internal
   policy.
5. **Re-review `risk_analysis.md` at two points**: right before your first
   live AWS deployment (`deploy_paid_infrastructure = true`), and again
   before onboarding your first real client. Both are explicitly noted in
   the document itself.
6. **Decide whether to also use a compliance-automation platform** (Vanta,
   Drata, Secureframe — roughly $1-3k/yr). These are not required — what's
   in this directory is a legitimate, real compliance program on its own —
   but such a platform adds continuous automated evidence collection
   against these same controls (often plugging directly into AWS Config/
   CloudTrail, which this repo's Terraform already provisions) and can
   simplify producing artifacts for a client's own vendor-security review.
   Treat it as an accelerant, not a prerequisite.
7. **Read `technical_standards/22_AI_LLM_PHI_Use_and_Model_Training_Restrictions.md`
   now, not later.** It governs how AI tools — including Claude, working in
   this repository — may be used once real PHI exists: no PHI in any AI
   system without written approval, an executed BAA, and a specifically
   eligible service. Treat it as binding on this working relationship once
   a real client's data is involved, not just a document about someone
   else's tooling.
8. **Fill in `technical_standards/24_Incident_Contact_and_Notification_Matrix.md`**
   with real names, phone numbers, and escalation paths before any live
   PHI — an incident procedure with no actual contacts is not usable at
   3am.
9. **Close the two real engineering gaps `17_Dependency_Container_and_Infrastructure_Scanning_Standard.md`
   and `21_Backup_Restoration_Test_Procedure.md` identify**: add container/
   IaC scanning to CI (Trivy/Checkov are reasonable starting points), and
   run one actual restore test against a non-production RDS instance.
   Neither is hard, both are currently just unperformed.

## How this maps to the AWS-side controls

The *technical* half of several of these policies is already implemented
in `infra/aws/terraform/security.tf` and `hardening.tf` (CloudTrail,
Config, GuardDuty, Security Hub, KMS encryption, optional WAF) and in
`engine/src/security/logging.ts` (PHI-safe log redaction). This directory
is the *organizational* half — the written policies, designated
responsibility, training, and incident procedure that a technical control
alone can't satisfy. A client's security reviewer, or an actual OCR audit,
will ask for both.
