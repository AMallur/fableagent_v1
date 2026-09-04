# Workforce Sanction Policy

**Citation:** 45 CFR §164.308(a)(1)(ii)(C) — apply appropriate sanctions
against workforce members who fail to comply with the security policies and
procedures. **Required** implementation specification under the Security
Management Process standard.
**Verified against:** [eCFR §164.308](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.308) (2026).

**Owner:** HIPAA Security Officer. **Review cycle:** annually.

## 1. Purpose

Establish that violations of the Company's HIPAA policies have real
consequences, and document what those consequences are, so the sanction
structure exists in writing before it is ever needed — not improvised after
an incident.

## 2. Scope

Applies to all workforce members: employees, contractors, and the founder,
with respect to any system in scope of the Access Control Policy.

## 3. Sanction tiers

| Tier | Example violations | Response |
|---|---|---|
| 1 — Minor, no data exposure | Sharing a non-sensitive credential informally against policy; delayed offboarding step caught in review | Documented verbal/written correction, policy re-training |
| 2 — Moderate, policy violation with limited/no confirmed exposure | Storing a secret outside Secrets Manager; bypassing a required review step | Written warning, mandatory re-training, access review |
| 3 — Serious, confirmed unauthorized access/disclosure | Accessing another tenant's data outside a legitimate support request; disclosing PHI outside authorized channels | Immediate access suspension pending investigation; may include termination of employment/contract and, where applicable, legal or regulatory referral |

## 4. Process

1. The Security Officer (or, if the Security Officer is the subject of the
   violation, a designated alternate — currently: none, since the Company
   is a single-person workforce; this is revisited at first hire) documents
   the violation, the tier, and the response taken.
2. Sanction records are retained for at least 6 years, consistent with the
   Company's general HIPAA documentation retention obligation
   (§164.316(b)(2)(i)).
3. A Tier 3 violation triggers the Incident Response and Breach
   Notification Policy in parallel, since it likely also constitutes a
   security incident.

## 5. Current status

No sanctions have been issued as of the date of this policy's adoption.
