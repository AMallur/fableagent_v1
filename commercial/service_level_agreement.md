# Service Level Agreement

> **Status: drafted, not yet substantiated.** The availability target below has
> never been measured against a production deployment, and the recovery
> objectives are targets from `docs/OPERATIONAL_RESILIENCE_RUNBOOK.md` that have
> not been exercised. Do not commit to these numbers contractually until the
> resilience exercise in required external gate 7 of
> `docs/PRODUCTION_READINESS.md` has been run and its measurements recorded.
> Offering an SLA you have not tested is how a first outage becomes a first
> lawsuit.

Applies to Customers in **live** operation. Shadow-mode Customers are not
charged and are not covered by service credits.

## 1. Availability

"Available" means the operational web interface and the administrative API
respond successfully to authenticated requests.

| Term | Commitment |
|---|---|
| Monthly availability target | `[99.5]%` |
| Measurement | Monthly, per calendar month, excluding Excluded Time |
| Reporting | On request; not currently automated |

**Excluded Time:** scheduled maintenance announced at least `[5]` business days
in advance and confined to a published window; Customer-caused unavailability;
failures of a Customer-side system, network or credential; and failures of a
payer, clearinghouse or other third party outside the Company's control.

Note that **batch processing is not covered by the availability target.** Nightly
detection, appeal generation and reconciliation are asynchronous, resume after a
failure, and a delayed run does not constitute unavailability. What matters
operationally to a Customer is §2, not §1.

## 2. Processing commitments

These are the commitments a billing operation actually cares about.

| Commitment | Target |
|---|---|
| Remittance and claim files placed in the ingest channel are processed | Within `[1]` business day of receipt |
| Detection findings available after ingestion | Same processing run |
| Appeal packets prepared for cases meeting the Customer's thresholds | Within `[2]` business days of the case opening |
| Recovery reconciliation | At least weekly |
| Appeal deadline alerting | Tiered at 14, 7 and 2 days before the deadline |

**A missed appeal deadline caused solely by the Company's failure to process a
file within the committed time is a Service Credit event under §4**, and is the
only failure mode in this agreement that can cost the Customer real money rather
than convenience.

## 3. Data protection and recovery

| Objective | Target | Status |
|---|---|---|
| Recovery Point Objective | `[15] minutes` | Configured (RDS point-in-time recovery); **not exercised** |
| Recovery Time Objective | `[4] hours` | Documented procedure; **not exercised** |
| Backup retention | `[35] days` | Configured in Terraform |

## 4. Service credits

Credits are the Customer's exclusive remedy for a failure to meet §1 or §2, and
are applied against the next invoice.

| Monthly availability | Credit |
|---|---|
| ≥ target | None |
| Below target but ≥ 99.0% | `[10]%` of that month's fees |
| Below 99.0% but ≥ 95.0% | `[25]%` of that month's fees |
| Below 95.0% | `[50]%` of that month's fees |

| Processing failure | Credit |
|---|---|
| A file not processed within the committed time | `[5]%` of that month's fees per occurrence |
| An appeal deadline missed solely through Company processing delay | The greater of `[25]%` of that month's fees and the recovery opportunity recorded on the affected case |

Credits are capped at `[100]%` of the fees for the affected month. The Customer
must claim within `[30]` days of the month end.

Because fees are largely contingent, a month with little recovery yields a small
credit — which is exactly backwards from the Customer's perspective when the
reason for low recovery was the outage. The deadline-miss credit above is
written against the case's recorded recovery opportunity for that reason, and a
Customer's counsel will likely and reasonably push for more.

## 5. Support

See `support_policy.md`. Severity definitions and response times there form part
of this agreement.

## 6. Exclusions

This agreement does not warrant:

- that any appeal will succeed, or that any specific amount will be recovered;
- the accuracy of payer adjudication, or of data supplied by the Customer or a
  clearinghouse;
- detection of every underpayment or denial — the platform is decision support,
  and the Customer remains responsible for its own revenue cycle;
- any coding determination. Corrected claims and modifier changes require the
  Customer's certified coding review.
