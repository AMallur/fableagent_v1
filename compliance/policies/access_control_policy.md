# Access Control Policy

**Citations:** 45 CFR §164.308(a)(3) (workforce security), §164.308(a)(4)
(information access management), §164.312(a) (technical access control).

**Owner:** HIPAA Security Officer. **Review cycle:** annually or after any
access-model change.

## 1. Purpose

Ensure that access to systems containing or capable of reaching ePHI is
granted only to authorized workforce members, only to the extent necessary
for their role (minimum necessary standard), and is removed promptly when no
longer needed.

## 2. Scope

Applies to: the production AWS account, the production PostgreSQL database,
the GitHub repository and its deploy secrets, the Optum/clearinghouse
credentials, and any administrative interface of the FableAgent application.

## 3. Policy

1. **Unique identity.** Every person with access to a system in scope has
   their own credentials. Shared logins/credentials are prohibited.
2. **Least privilege.** Access is scoped to the minimum required for the
   person's role. In AWS, this means named IAM users/roles with
   purpose-scoped policies, not `AdministratorAccess`, for anyone other than
   the Security Officer's own break-glass account.
3. **Database access.** Application runtime access uses the non-superuser
   roles defined in the schema migrations (`rcm_runtime`, `rcm_app`,
   `rcm_service`), which are subject to row-level security and cannot bypass
   tenant isolation. Direct superuser/admin database access is limited to
   the person(s) performing migrations and is not used for day-to-day
   operations.
4. **Application-level access.** The web application enforces tenant
   scoping and role-based permissions in `engine/src/web/`; a user
   authenticated to one tenant cannot query another tenant's data through
   normal application paths.
5. **Termination/offboarding.** When a workforce member's access is no
   longer needed (role change, departure, contractor engagement ending),
   their credentials are revoked the same business day: AWS IAM
   user/role, database role membership, GitHub repository access, and any
   third-party credentials (Optum, SMTP) they held.
6. **Periodic review.** Once the Company has more than one workforce member
   with system access, the Security Officer reviews the full access list at
   least quarterly and removes anything no longer justified. Until then,
   this review is implicitly satisfied by there being one workforce member,
   but the Security Officer still confirms annually that no stale
   credentials (old IAM keys, old database roles) remain.
7. **Credential storage.** Secrets (database passwords, session/encryption
   keys, SMTP, Optum client credentials) are stored in AWS Secrets Manager,
   never in source control, chat, email, or plaintext files. Handoff of AWS
   access for deployment purposes uses least-privilege IAM credentials
   stored as GitHub Actions secrets and consumed by `workflow_dispatch`
   pipelines — never pasted directly to a third party.
8. **Emergency access.** In the event normal access is unavailable during
   an incident, the Security Officer may use root/break-glass AWS
   credentials, which are stored offline (not in daily-use password
   managers) and whose use is logged via CloudTrail and reviewed after the
   fact.

## 4. Enforcement

Violation of this policy (credential sharing, provisioning access beyond
what a role requires, failure to revoke access on offboarding) is addressed
per the Workforce Sanction Policy.
