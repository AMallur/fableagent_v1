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

## How this maps to the AWS-side controls

The *technical* half of several of these policies is already implemented
in `infra/aws/terraform/security.tf` and `hardening.tf` (CloudTrail,
Config, GuardDuty, Security Hub, KMS encryption, optional WAF) and in
`engine/src/security/logging.ts` (PHI-safe log redaction). This directory
is the *organizational* half — the written policies, designated
responsibility, training, and incident procedure that a technical control
alone can't satisfy. A client's security reviewer, or an actual OCR audit,
will ask for both.
