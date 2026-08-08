# Vendor / Subcontractor Business Associate Agreement Management Policy

**Citation:** 45 CFR §164.308(b) (business associate contracts), §164.502(e)
(disclosures to business associates).

**Owner:** HIPAA Security Officer. **Review cycle:** before onboarding any
new vendor that can access ePHI, and annually thereafter.

## 1. Policy

1. **No subprocessor touches ePHI without an executed BAA first.** This
   applies whether the vendor is infrastructure (AWS), a clearinghouse
   (Optum/Change Healthcare), or a communications provider (SMTP/email).
   "Touches ePHI" includes any vendor whose service could foreseeably
   receive, transmit, or store it, even if the current configuration tries
   to avoid sending them PHI directly.
2. **Current subprocessor status:**

   | Vendor | Role | BAA status |
   |---|---|---|
   | AWS | Infrastructure hosting (RDS, S3, ECS, KMS, etc.) | In progress — confirm final execution and record the date below |
   | Optum / Change Healthcare | Clearinghouse (claim submission, status checks) | Sandbox credentials only; production trading-partner agreement (which functions as the operative BAA-equivalent relationship for this data flow) required before live submission — see `docs/PRODUCTION_READINESS.md` gate 4 |
   | SMTP/email provider | Transactional email (digests, alerts) | Not yet selected; SMTP remains disabled (`smtp_secret_arn = ""`) until a BAA-covered provider is contracted |

3. **Before enabling any new integration that can carry ePHI**, the
   Security Officer confirms a BAA is executed and files/records it, before
   flipping the corresponding feature flag or credential into production
   use. This mirrors the software's own fail-closed pattern (e.g.,
   `OPTUM_ALLOW_LIVE_SUBMISSION` defaulting off) at the organizational
   level.
4. **BAA content review.** At minimum, confirm each executed BAA covers:
   permitted uses/disclosures, safeguard obligations, breach notification
   obligations back to the Company, subcontractor flow-down requirements
   (the vendor's own subprocessors must be bound too), and data return/
   destruction on termination.
5. **Annual review.** Re-confirm each active subprocessor still has a
   current BAA on file and that the relationship still matches what was
   contracted (no material change in what data the vendor can access).

## 2. Recordkeeping

Store executed BAA copies in a durable, access-controlled location (not
committed to this source-controlled repository, since a real BAA may
contain counterparty-identifying legal detail). This policy file is the
index of *status*; the documents themselves live elsewhere. Update the
table in §1 whenever a BAA is executed, amended, or terminated.
