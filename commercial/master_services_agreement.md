> ## ⚠️ ATTORNEY REVIEW REQUIRED BEFORE USE
>
> This is a drafting starting point, not an agreement. **Do not send it to a
> customer or sign it as-is.** It has not been reviewed by counsel, it takes
> positions on liability and indemnity that a healthcare technology attorney
> should set deliberately against your own risk posture and insurance, and it
> omits terms your jurisdiction may require. Have counsel review and revise it
> before it is executed with any real customer. This is not legal advice.
>
> The clauses most likely to need real legal attention are flagged inline as
> **[COUNSEL]**.

# Master Services Agreement

Between `[COMPANY LEGAL NAME]` ("Company") and `[CUSTOMER LEGAL NAME]`
("Customer"), effective `[DATE]`.

## 1. Structure

This Agreement governs. Commercial terms for each engagement are set in an Order
Form executed under it (`order_form_template.md`). Where an Order Form conflicts
with this Agreement, the Order Form controls for that engagement only.

The following are incorporated by reference: the Business Associate Agreement
(`compliance/baa_template.md`, executed separately), the Service Level Agreement
(`service_level_agreement.md`) and the Support Policy (`support_policy.md`).

## 2. Services

The Company provides a revenue-cycle recovery platform that ingests the
Customer's claim and remittance data, identifies suspected underpayments and
denials, prepares appeal documentation, and reconciles recovered payment.

**The Services are decision support.** The Company does not practise medicine,
provide coding advice, or assume responsibility for the Customer's revenue cycle.
Every corrected claim and modifier change requires the Customer's own certified
coding review before submission.

## 3. Operating modes

Each Customer operates in one of two modes, recorded in the platform:

- **Shadow.** The platform ingests, detects, prices and prepares. It transmits
  nothing to any payer and no fees are charged. Every engagement begins here.
- **Live.** Normal operation under the Order Form's submission authority and
  fees.

Movement to live requires a preflight with no blocking failures and the
Customer's written confirmation. Either party may return the Customer to shadow
at any time, immediately and without cause.

## 4. Customer responsibilities

The Customer will: supply accurate claim and remittance data and current
contracted rate schedules; maintain its own payer relationships and enrolments;
apply certified coding review to any corrected claim; designate personnel to
review findings; and maintain the lawful basis for the Company to process
protected health information on its behalf.

**The Customer remains the party responsible to payers for everything submitted
under its identifiers**, whether prepared by the Company or not. **[COUNSEL]**

## 5. Fees

As set in the Order Form. Fees are invoiced monthly in arrears. No fees accrue
during shadow-mode operation.

Contingency fees are charged on recovery the platform attributed and can evidence
line by line, measured on the basis recorded in the Order Form. The Company will
not issue an invoice under commercial terms that do not name an executed
agreement, and the platform enforces this.

Each invoice is accompanied by a statement identifying every payment charged
against. Disputed lines may be withheld pending resolution under the Support
Policy; undisputed lines remain due. Late undisputed amounts accrue interest at
`[1]%` per month or the maximum permitted by law, whichever is lower.
**[COUNSEL]**

## 6. Protected health information

Processing of PHI is governed exclusively by the executed Business Associate
Agreement, which controls over this Agreement on any matter it addresses.

The Company will maintain the administrative, physical and technical safeguards
described in its compliance documentation, and will notify the Customer of a
suspected breach of unsecured PHI without unreasonable delay and within the
period required by the BAA and applicable law. **[COUNSEL — notification
timing is regulated and must not be softened here.]**

## 7. Data ownership and records

Customer data remains the Customer's. The Company may use it only to provide the
Services and as the BAA permits. The Company does not use Customer data to train
machine-learning models.

On termination, the Company will return or destroy Customer data as the BAA
requires, **except** that the audit log and billing ledger are append-only
records retained under the Company's documented retention schedule. The Customer
acknowledges this in advance. **[COUNSEL — this exception is real, is enforced
in the database, and must survive review rather than be quietly dropped.]**

The Customer may request an evidence pack for any period at no charge, during
the term and for `[12] months` after termination.

## 8. Warranties and disclaimers

Each party warrants it has authority to enter this Agreement. The Company
warrants it will perform with reasonable skill and care and in accordance with
the Service Level Agreement.

**The Company does not warrant that any appeal will succeed, that any particular
amount will be recovered, or that every underpayment or denial will be
detected.** Except as expressly stated, the Services are provided without further
warranty of any kind. **[COUNSEL]**

## 9. Limitation of liability

**[COUNSEL — this entire section must be set by counsel against your insurance
and risk posture. The figures below are placeholders and are not a
recommendation.]**

Neither party is liable for indirect, incidental, special or consequential
damages. Each party's aggregate liability is limited to the fees paid or payable
in the `[12]` months preceding the claim, except for: breach of confidentiality
or PHI obligations; a party's gross negligence or wilful misconduct; and the
Customer's payment obligations.

## 10. Indemnity

**[COUNSEL — scope, caps and control of defence all require legal judgement.]**

Each party indemnifies the other against third-party claims arising from its own
breach of the BAA or its own negligence, subject to prompt notice, cooperation
and control of the defence.

## 11. Term and termination

Initial term and renewal are set in the Order Form. Either party may terminate
for material breach not cured within `[30]` days of written notice, or
immediately on the other's insolvency.

On termination the Customer pays fees accrued to the termination date, including
contingency on recovery already attributed. **[COUNSEL — whether contingency
survives on appeals filed before termination but paid afterwards is a real
commercial question and should be decided deliberately rather than left silent.]**

## 12. General

Confidentiality; assignment on change of control with notice; governing law
`[STATE]`; dispute resolution `[FORUM]`; force majeure; notices in writing;
entire agreement; amendment in writing signed by both parties. **[COUNSEL]**

---

| Customer | Company |
|---|---|
| Name: `________________` | Name: `________________` |
| Title: `________________` | Title: `________________` |
| Date: `________________` | Date: `________________` |
