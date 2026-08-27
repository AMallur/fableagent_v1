# Support policy

Applies to Customers in live operation. Shadow-mode Customers receive
best-effort support during their pilot at no charge.

## Severity and response

| Severity | Definition | First response | Target resolution |
|---|---|---|---|
| **S1 — Critical** | Platform unavailable, PHI exposure suspected, or an appeal deadline is at risk of being missed because of a platform fault | `[1] hour`, 24×7 | `[4] hours` or a workaround |
| **S2 — High** | A core function is broken for a Customer — ingestion failing, detection not running, invoices wrong — with no workaround | `[4] business hours` | `[2] business days` |
| **S3 — Normal** | A function is impaired but has a workaround; a finding is disputed | `[1] business day` | `[10] business days` |
| **S4 — Low** | Question, configuration change, feature request | `[2] business days` | Scheduled |

Business hours are `[09:00–17:00 CT, Monday–Friday, excluding US federal
holidays]`.

**Anything touching a filing or appeal deadline is S1 regardless of how it is
reported.** Deadlines do not move, and a missed one is unrecoverable revenue.

## How to raise an issue

| Route | Use for |
|---|---|
| `[support@company]` | S2–S4 |
| `[phone/pager]` | S1 only, 24×7 |
| In-platform notifications | Alerts the platform raises itself |

When reporting a disputed finding or invoice line, quote the claim number shown
against it — every case, statement line and ledger entry carries one, and it is
the fastest route to an answer.

## Escalation

| Level | Contact | Trigger |
|---|---|---|
| 1 | Support | Initial report |
| 2 | `[Engineering lead]` | Target response missed, or S1 open > `[2] hours` |
| 3 | `[Company principal]` | S1 open > `[8] hours`, or any suspected PHI incident |

A suspected PHI incident goes to level 3 immediately and in parallel, and
triggers the incident response procedure in
`compliance/policies/incident_response_policy.md` — including the breach
notification assessment, which is time-bound by regulation and not by this
policy.

## Disputed invoice lines

1. The Customer identifies the disputed line by claim number.
2. The Company provides the underlying evidence — the payment events, the
   attribution components and the remittance behind them — within `[3] business
   days`.
3. If the line is wrong, the invoice is **voided and reissued**. Issued invoices
   are immutable in the platform by design, so a correction is always a new
   document and the original remains visible as part of the record.
4. Undisputed lines remain due while a dispute is open.

## What support does not cover

- Coding advice or clinical documentation review. The platform is decision
  support; certified coding review remains the Customer's responsibility.
- Payer relationships, negotiation, or the outcome of any appeal.
- Customer-side systems, EHR or practice-management integrations beyond the
  agreed ingest channel.
