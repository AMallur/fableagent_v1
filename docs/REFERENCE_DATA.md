# External reference-data contract

FableAgent imports external data only through documented canonical CSV
schemas. Raw publisher downloads must be transformed and reviewed explicitly;
the importer rejects missing, renamed, or unexpected columns. Each accepted
dataset records its kind, version, scope, authoritative HTTPS source,
effective date, SHA-256 digest, row count, and import time.

## Authoritative sources

- CMS 837P/835 5010 implementation references and companion guides:
  <https://www.cms.gov/medicare/regulations-guidance/legislation/versions-5010-d0-30/ffs-updates>
- CMS Medicare Fee Schedule files and ZIP-to-locality file:
  <https://www.cms.gov/medicare/payment/fee-schedules>
- CMS NCCI PTP quarterly edits:
  <https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits>
- X12 CARC/RARC code lists:
  <https://x12.org/codes>
- CMS place-of-service codes:
  <https://www.cms.gov/medicare/coding-billing/place-of-service-codes/code-sets>

## Canonical schemas

Headers are exact and order-independent. Extra columns are rejected.

| Kind | Required header |
|---|---|
| `medicare_pfs` | `procedure_code,modifier,locality,effective_year,nonfacility_rate,facility_rate` |
| `carc` / `rarc` | `code,description,start_date,last_modified,stop_date,status` |
| `ncci_ptp` | `column_one_code,column_two_code,effective_date,deletion_date,modifier_indicator` |

Dates use `YYYY-MM-DD`; blank optional dates are allowed. NCCI modifier
indicators must be `0`, `1`, or `9`. NCCI imports also require an explicit
`practitioner` or `outpatient_hospital` service setting.

Example import:

```sh
node src/cli.ts reference-import \
  --kind medicare_pfs --version 2026-Q3 --scope national-all-localities \
  --effective-date 2026-07-01 --file cms-pfs-canonical.csv \
  --source-url https://www.cms.gov/medicare/payment/fee-schedules
```

Reimporting the same kind/version/scope and SHA is idempotent. Reusing that
identity with different bytes is rejected; publish a corrected version label
instead of silently changing history.

## Medicare pricing safety

Imported PFS rows retain both facility and nonfacility rates and locality.
The client must be mapped explicitly to a CMS locality from the current CMS
ZIP crosswalk. FableAgent currently automates the nonfacility office setting
(POS 11) and a conservative set of hospital/ER/ASC/SNF facility settings (POS
19, 21, 22, 23, 24, and 31). Other POS values fail closed for imported
Medicare pricing until their rule is configured and validated.

A percent-of-Medicare contract cannot be activated unless versioned facility
and nonfacility rates exist for every structured contract line and the
configured locality/year. Fixed negotiated fee schedules do not depend on CMS
rates.

## Licensing

CPT content is copyrighted by the American Medical Association. The database
stores only transaction codes needed to process the customer's claims; this
repository does not ship CPT descriptors, codebooks, or a fabricated license.
The operator must obtain the rights needed for its intended use and any
redistribution. HCPCS/CMS and X12 materials remain subject to their publishers'
terms as well.
