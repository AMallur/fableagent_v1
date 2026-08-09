# Device and Media Controls Policy

**Citation:** 45 CFR §164.310(d) — policies and procedures governing the
receipt and removal of hardware/electronic media containing ePHI into and
out of a facility, and their movement.

**Owner:** HIPAA Security Officer. **Review cycle:** annually.

## 1. Applicability

FableAgent's production ePHI lives in AWS-managed infrastructure (RDS, S3),
not on physical media the Company controls directly, which limits most of
this policy's traditional scope (no on-prem servers, no physical backup
tapes). This policy governs the parts that remain relevant: workforce
devices used to access production systems, and any physical/portable media
that ever briefly holds ePHI during client onboarding.

## 2. Policy

1. **Workstations accessing production systems** (AWS console, database
   admin tools, or the application's admin interface) must have disk
   encryption enabled (e.g., FileVault/BitLocker) and a lock-screen timeout
   configured. ePHI must not be stored locally on a workstation as a matter
   of routine operation — access is through the application/AWS console,
   not by exporting data to local files.
2. **Client-provided onboarding data** (historical claims files, contract/fee
   schedule documents, sample 835/837 files used for payer validation) is
   uploaded directly to the Company's encrypted storage as soon as
   received, and any local/temporary copy used during that transfer is
   securely deleted afterward (not left in a Downloads folder or email
   attachment).
3. **No removable media.** ePHI is not copied to USB drives, personal cloud
   storage, or other portable/removable media, except where a specific
   client's own secure-transfer requirement (e.g., their SFTP endpoint)
   dictates the exchange mechanism, in which case that mechanism itself
   must be encrypted in transit.
4. **Disposal.** When a device that has accessed production ePHI-capable
   systems is retired, its disk is securely wiped or the device is
   physically destroyed before disposal or resale, consistent with NIST SP
   800-88 media sanitization guidance.
5. **Cloud resource disposal.** Decommissioned AWS resources (old RDS
   snapshots, old S3 objects) are deleted through the AWS console/API, which
   destroys the underlying encrypted data such that with the KMS key
   controlled by the Company, deleting the key (after the mandatory waiting
   period) or the object itself renders the data unrecoverable.

## 3. Current status

The Company currently operates from a single workforce member's
workstation(s). Full inventory tracking of authorized devices becomes
necessary once workforce grows beyond one person; formalize a device
inventory at that point.
