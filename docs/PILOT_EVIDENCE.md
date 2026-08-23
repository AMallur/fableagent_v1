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

## Real-world external validation

Use `docs/EXTERNAL_VALIDATION_PROTOCOL.md` before reviewing real-world results.
The study scope, denominator, exclusions, reviewers, metrics, and any pass/fail
thresholds should be fixed before results are unblinded.

A machine-readable review file can be scored with:

```sh
cd engine
npm run validation:external -- --input validation.json --output-dir var/external_validation
```

The validator reports precision, 95% confidence intervals, coverage, unresolved
rate, count/dollar accuracy measures, and recall only when the input explicitly
declares that a complete ground-truth review was performed. The tool cannot
create independent validation by itself; the customer/reviewer evidence is the
source of truth.

## Immutable evidence bundle

For a real case study, retain a separate evidence bundle containing:

- signed/pre-registered pilot scope and data dictionary;
- input file inventory, control totals, source hashes, and ingest job IDs;
- contract/reference dataset versions and approval record;
- frozen adjudicated validation sample;
- finding-level reviewer disposition and rationale;
- complete missed-opportunity table when recall is claimed;
- submission confirmations and payer acknowledgements;
- post-action payment matches; and
- metric output using definitions from `PILOT_RUNBOOK.md` and
  `EXTERNAL_VALIDATION_PROTOCOL.md`.

After assembling the evidence files, generate a cryptographic manifest:

```sh
cd engine
npm run evidence:manifest -- \
  --bundle-id pilot-001 \
  --engine-commit <git-sha> \
  --protocol-version external-validation-v1 \
  --output evidence-manifest.json \
  --files <protocol> <source-inventory> <review-table> <metrics> <other-evidence>
```

The manifest records every file's byte length and SHA-256 digest and produces a
canonical manifest digest. Keep the manifest with the published evidence. If a
source or result changes, verification fails and a new bundle version is
required.

Do not overwrite an evidence bundle after publication. Corrections should be a
new dated/versioned bundle with an explanation of the change.

Use `docs/RELEASE_EVIDENCE_TEMPLATE.md` for customer-facing releases and
`docs/COMMERCIAL_ASSURANCE_MATRIX.md` to distinguish repository evidence from
deployment, customer, and third-party attestations.
