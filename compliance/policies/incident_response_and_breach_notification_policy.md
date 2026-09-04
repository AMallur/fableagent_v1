# Incident Response and Breach Notification Policy

**Citations:** 45 CFR §164.308(a)(6) (security incident procedures), 45 CFR
§§164.400–414 (Breach Notification Rule).
**Verified against:** [eCFR §164.308](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.308),
[eCFR §164.402](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-D/section-164.402),
[eCFR §164.410](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-D/section-164.410) (2026).
The four-factor test in §3 step 3 and the 60-calendar-day BA→covered-entity
notification deadline in §3 step 4 match the current regulatory text
exactly, including that discovery is deemed to occur not only when actually
learned but when it should have been learned through reasonable diligence
(§164.410(a)(2)) — the containment step in §3 step 1 should not wait for
certainty before starting that clock.

**Owner:** HIPAA Security Officer. **Review cycle:** annually, and
immediately after any real incident (lessons-learned update).

## 1. Definitions

- **Security incident:** any attempted or successful unauthorized access,
  use, disclosure, modification, or destruction of information, or
  interference with system operations, in an information system that
  handles or can reach ePHI.
- **Breach:** an impermissible use or disclosure of unsecured PHI that
  compromises the security or privacy of the PHI, unless the Company
  demonstrates a low probability of compromise through the four-factor risk
  assessment required by §164.402.

## 2. Detection

The following are the Company's current detection sources. As of this
writing, no live production deployment exists yet, so these describe the
design; each item is re-verified as "actually receiving events" once
infrastructure is live.

- AWS GuardDuty (threat detection), CloudTrail (API activity, including S3
  object-level events on the documents bucket), AWS Config (configuration
  drift), Security Hub (aggregated findings) — all defined in
  `infra/aws/terraform/security.tf`.
- CloudWatch alarms on abnormal ALB error rates, DB resource exhaustion
  (`infra/aws/terraform/main.tf`, `hardening.tf`).
- Application-level: failed authentication patterns, unusual data-access
  volume, and job failures surfaced through `system_job` records.
- Direct reports: a client, workforce member, or vendor reports something
  suspicious.

## 3. Response procedure

1. **Identify and contain.** The person who discovers or is notified of a
   suspected incident notifies the Security Officer immediately. The
   Security Officer's first priority is containment: revoke compromised
   credentials, isolate the affected resource (e.g., restrict a security
   group, disable a compromised IAM key), and preserve evidence (CloudTrail
   logs, relevant `system_job` records) before remediating.
2. **Investigate and document.** For each incident, record: what happened,
   when it was discovered, what systems/data were involved, whether ePHI
   was actually accessed or only potentially exposed, and the containment
   actions taken. Use a dated entry in an incident log (create
   `compliance/incident_log/` with one file per incident when the first
   real incident occurs — none exists yet because there has been no
   incident).
3. **Determine if it is a reportable breach.** Apply the four-factor risk
   assessment (45 CFR §164.402):
   - The nature and extent of the PHI involved (types of identifiers,
     likelihood of re-identification).
   - The unauthorized person who used the PHI or to whom it was disclosed.
   - Whether the PHI was actually acquired or viewed.
   - The extent to which the risk has been mitigated.
   Document this assessment in writing regardless of outcome — even a
   determination of "not a reportable breach" needs a documented rationale.
4. **Notify, if required.** If the four-factor assessment concludes a
   reportable breach occurred:
   - **Notify each affected covered-entity client without unreasonable
     delay and no later than 60 days** after discovery, since as a business
     associate the Company's contractual/BAA obligation is to notify the
     covered entity (who then owns notifying affected individuals and, for
     breaches of 500+ records, media, unless the BAA assigns notification
     duties differently — confirm against the specific client BAA).
   - Provide the client with what is known: a description of what
     happened, the types of PHI involved, and the steps the Company has
     taken/will take to mitigate and prevent recurrence, per §164.410.
   - If the Company itself qualifies as needing to notify HHS directly
     (rare for a business associate unless the BAA specifically assigns
     that duty), follow the HHS breach-portal reporting process at
     [hhs.gov/hipaa/for-professionals/breach-notification](https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html).
5. **Remediate and update.** After containment and notification, implement
   the fix that prevents recurrence, and update this policy or the risk
   analysis (`compliance/risk_analysis.md`) if the incident revealed a gap.

## 4. Severity guide (for triage speed, not a substitute for the four-factor test)

| Signal | Example | Initial response time |
|---|---|---|
| Active unauthorized access to ePHI | Compromised DB or AWS credential in active use | Immediate — contain within the hour |
| Potential exposure, no confirmed access | Misconfigured S3 permission discovered by Config, no confirmed external access in CloudTrail | Same business day |
| Vendor-side incident | Notification from AWS or Optum of an incident on their side | Same business day — assess Company exposure |
| Policy violation, no data exposure | Credential shared against policy but not misused | Within 3 business days — corrective action |

## 5. Testing

The Security Officer should tabletop this procedure at least once before
onboarding the first real client (e.g., "assume a leaked AWS access key —
walk the steps") and record the date and outcome below.

| Date | Type | Outcome |
|---|---|---|
| — | — | Not yet performed |
