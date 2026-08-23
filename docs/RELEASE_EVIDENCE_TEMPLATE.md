# Commercial release evidence record

Use one copy of this record for every customer-facing release or pilot evidence publication. Replace every placeholder; do not mark a control complete without attached evidence.

## Release identity

- Release ID:
- Git commit:
- Container/image digest:
- Deployment environment:
- Infrastructure version/commit:
- Release owner:
- Approval date:

## Customer/scope

- Customer/pilot identifier:
- Provider/specialty scope:
- Payers in scope:
- Claim types/transaction versions:
- Contract models in scope:
- Explicit exclusions:
- Autonomous outbound actions enabled: yes/no

## Automated repository evidence

- CI run:
- Unit tests: pass/fail + link/artifact
- Integration tests: pass/fail + link/artifact
- Non-superuser RLS tests: pass/fail + link/artifact
- Production dependency audit: pass/fail + output
- CodeQL: pass/fail + run
- Runtime image build: pass/fail + digest
- Infrastructure validation: pass/fail + output

## Deployment evidence

- HTTPS/TLS verification:
- Secret-manager configuration review:
- Database encryption evidence:
- Object-storage encryption/versioning/retention evidence:
- Backup timestamp and restore exercise ID:
- Measured RPO result:
- Measured RTO result:
- Load/capacity exercise ID:
- Logging/alert test:
- Incident contacts verified:

## External/commercial evidence

- BAA/DPA status and execution date:
- Relevant vendor/subprocessor BAAs:
- Independent penetration-test report/date:
- Open high/critical findings:
- Customer contract-rate validation record:
- External finding-validation bundle ID:
- Evidence manifest SHA-256:
- Reviewer organization/roles:
- Qualified coding review requirement satisfied: yes/no/not applicable
- Trading-partner certification for live outbound connector: yes/no/not applicable
- Required content/reference licenses current: yes/no/not applicable
- Cyber/E&O insurance evidence if required:

## Known risks and exceptions

For every exception record severity, owner, mitigation, expiration/review date, and who accepted the risk. A planned fix is not evidence that the control passed.

| Risk/exception | Severity | Mitigation | Owner | Review/expiry | Accepted by |
|---|---|---|---|---|---|
| | | | | | |

## Validation claims approved for external use

List the exact statements that sales, case studies, security questionnaires, or customer materials may use. Each statement must be traceable to evidence above.

- Claim:
  - Evidence:
  - Dataset/date range:
  - Numerator/denominator:
  - Limitations:

## Final decision

- [ ] Automated release gates passed.
- [ ] Required deployment controls were exercised in the target environment.
- [ ] Required customer/third-party evidence is attached and current.
- [ ] Known risks are documented and formally accepted where permitted.
- [ ] Marketing/commercial claims are limited to what the evidence supports.
- [ ] Release owner approves this exact release for the stated scope.

Release decision: **GO / NO-GO**

Approver:
Date:
