# Pilot evidence package

FableAgent includes a deterministic 1,000-line synthetic benchmark covering
full payment, patient responsibility, below-threshold variance, actionable
underpayment, denial, split payments, supplemental payments, unknown patient
responsibility, and replayed remittances.

Run it with:

```sh
cd engine
npm run benchmark:pilot
```

It writes `var/pilot_benchmark/report.json` and `report.md`. The command exits
nonzero if its expected flags or dollars drift. This is regression evidence,
not clinical validation, customer evidence, or recovered revenue.

For a real case study, retain a separate evidence bundle containing:

- signed pilot scope and data dictionary;
- input file inventory, control totals, source hashes, and ingest job IDs;
- contract/reference dataset versions and approval record;
- frozen adjudicated validation sample;
- finding-level reviewer disposition and rationale;
- submission confirmations and payer acknowledgements;
- post-appeal payment matches; and
- metric workbook with definitions from `PILOT_RUNBOOK.md`.

Do not overwrite an evidence bundle after publication. Corrections should be a
new dated/versioned bundle with an explanation of the change.
