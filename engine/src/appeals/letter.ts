// ============================================================================
// MODULE: APPEAL LETTER GENERATOR (pure)
//
// generateAppealLetter(ctx, attachments) -> { fileName, content }
//
// Letter structure per spec:
//   1. header (provider name, NPI, address, date)     5. category-specific body
//   2. payer name + appeal submission address         6. closing with deadline
//   3. RE: line (patient, DOB, claim, DOS, amount)    7. signature block
//   4. opening paragraph                              8. attachment list
// ============================================================================

import type { AppealCaseContext, Address, LetterCategory } from './types.ts';

const usd = (n: number | null | undefined): string =>
  n == null ? 'N/A' : `$${n.toFixed(2)}`;

function formatAddress(a: Address | null): string[] {
  if (!a) return [];
  const cityLine = [a.city, a.state].filter(Boolean).join(', ')
    + (a.zip ? ` ${a.zip}` : '');
  return [a.line1, a.line2, cityLine.trim()].filter((x): x is string => !!x && x.length > 0);
}

/** Map the case's denial_category / case_type onto a letter template. */
export function letterCategory(ctx: AppealCaseContext): LetterCategory {
  switch (ctx.denialCategory) {
    case 'clinical_medical_necessity': return 'medical_necessity';
    case 'authorization': return 'authorization';
    case 'bundling': return 'bundling';
    case 'timely_filing': return 'timely_filing';
    case 'duplicate': return 'duplicate';
    case 'coding': return 'coding';
    case 'contractual': return 'underpayment';
    default:
      return ctx.caseType === 'underpayment' ? 'underpayment' : 'general';
  }
}

function codeList(ctx: AppealCaseContext): string {
  const codes = ctx.claimLines.map(
    (l) => l.procedureCode + (l.modifiers.length ? `-${l.modifiers.join('-')}` : ''),
  );
  return [...new Set(codes)].join(', ');
}

// ---------------------------------------------------------------------------
// category bodies
// ---------------------------------------------------------------------------

function body(ctx: AppealCaseContext): string[] {
  const denialRef = ctx.denialReasonCode ? ` (denial code ${ctx.denialReasonCode})` : '';

  switch (letterCategory(ctx)) {
    case 'medical_necessity':
      return [
        `The services billed under procedure code(s) ${codeList(ctx)} were medically necessary for the diagnosis and treatment of this patient. The denial${denialRef} does not reflect the clinical circumstances documented in the medical record.`,
        `The treatment provided is consistent with generally accepted standards of medical practice and applicable clinical guidelines for the patient's condition, including specialty society guidance and, where applicable, the plan's own published medical policy.`,
        `We request reconsideration of this claim with the enclosed clinical documentation, which substantiates the medical necessity of the services rendered. Please have this appeal reviewed by a physician of the same or similar specialty as the treating provider.`,
      ];

    case 'authorization': {
      const auth = ctx.authorizationNumber;
      return [
        auth
          ? `This service was authorized prior to rendering. Authorization number ${auth} was issued for this patient and date of service, and is documented in our records and the enclosed documentation.`
          : `Our records indicate this service met your plan's authorization requirements. We are pursuing confirmation of the authorization on file and request review of the denial${denialRef} in the interim.`,
        auth
          ? `Because a valid authorization was in place at the time of service, the denial${denialRef} for absent authorization or precertification is in error.`
          : `The denial${denialRef} should be reconsidered in light of the plan's authorization records for this member and date of service.`,
        `We request payment of this claim in accordance with the authorization issued${auth ? ` (${auth})` : ''} and the member's benefit plan.`,
      ];
    }

    case 'bundling': {
      const mods = [...new Set(ctx.claimLines.flatMap((l) => l.modifiers))];
      return [
        `The services billed under procedure code(s) ${codeList(ctx)} were denied${denialRef} as included in the payment for another service. ${mods.length ? `Modifier(s) ${mods.join(', ')} were appended to identify the services as separately reportable.` : 'The services are separately reportable as documented in the medical record.'}`,
        `These services are distinct: they were performed at separate anatomic sites, during separate patient encounters, or represent separately identifiable services beyond the primary procedure, as documented in the clinical record.`,
        `Per CMS National Correct Coding Initiative (NCCI) policy, services meeting the criteria for a valid modifier bypass are separately payable when appropriately documented. We request reprocessing of these lines in accordance with CMS NCCI guidance and the enclosed documentation.`,
      ];
    }

    case 'underpayment': {
      const lines = ctx.claimLines
        .filter((l) => l.expectedAmount != null)
        .map((l) => {
          const paid = l.paidAmount ?? 0;
          const variance = (l.expectedAmount ?? 0) - paid;
          return `  - CPT ${l.procedureCode}${l.modifiers.length ? '-' + l.modifiers.join('-') : ''}: `
            + `contracted rate ${usd(l.expectedAmount)}, paid ${usd(paid)}, `
            + `underpayment ${usd(variance)}`;
        });
      return [
        `Payment received on this claim is below the rate set by the participation agreement between ${ctx.clientName} and ${ctx.payerName}${ctx.contract ? ` (fee schedule methodology: ${ctx.contract.feeScheduleType.replaceAll('_', ' ')}, effective ${ctx.contract.effectiveDate})` : ''}.`,
        `The contracted rate versus payment received:\n${lines.join('\n')}\n  Total expected: ${usd(ctx.expectedAmount)}\n  Total paid: ${usd(ctx.paidAmount)}\n  Amount owed: ${usd(ctx.recoveryOpportunity)}`,
        `We request a corrected payment of ${usd(ctx.recoveryOpportunity)} in accordance with the terms of our agreement. An excerpt of the applicable fee schedule is enclosed.`,
      ];
    }

    case 'timely_filing':
      return [
        `This claim was denied${denialRef} for untimely filing. Our records show the claim was originally submitted on ${ctx.submissionDate ?? '[submission date on file]'}, within the filing period applicable to this agreement.`,
        `Enclosed is proof of timely filing documenting the original submission. Under your published timely filing policy and applicable law, a claim submitted within the filing limit and supported by submission evidence must be processed on its merits.`,
        `We request that the timely filing denial be reversed and the claim processed for payment.`,
      ];

    case 'duplicate':
      return [
        `This claim was denied${denialRef} as a duplicate. The services billed are not duplicative: they represent distinct services rendered to this patient as documented in the medical record.`,
        `The original claim (claim number ${ctx.claimNumberInternal}${ctx.claimNumberPayer ? `, payer claim number ${ctx.claimNumberPayer}` : ''}, date of service ${ctx.dateOfService}) is separately identifiable from any other claim on file for this patient.`,
        `We request that this claim be processed as a separate service and paid accordingly.`,
      ];

    case 'coding':
      return [
        `The procedure code(s) ${codeList(ctx)} billed on this claim accurately describe the services rendered, consistent with current CPT guidelines and the documentation in the medical record.`,
        `${ctx.claimLines.some((l) => l.modifiers.length) ? `The modifier(s) appended (${[...new Set(ctx.claimLines.flatMap((l) => l.modifiers))].join(', ')}) are supported by CPT modifier guidance for the clinical circumstances documented.` : 'Where modifiers apply, they have been appended consistent with CPT modifier guidance for the clinical circumstances documented.'}`,
        `We request reprocessing of this claim${denialRef ? ` and reversal of the denial${denialRef}` : ''} based on the coding rationale and documentation enclosed.`,
      ];

    case 'general':
      return [
        `We dispute the adjudication of this claim${denialRef}. Based on our review of the remittance advice and the member's coverage, the claim was not processed in accordance with the member's benefits and our agreement.`,
        `We request reconsideration of this claim with the enclosed supporting documentation.`,
      ];
  }
}

// ---------------------------------------------------------------------------
// full letter
// ---------------------------------------------------------------------------

export interface GeneratedLetter {
  fileName: string;
  content: string;
}

export function generateAppealLetter(
  ctx: AppealCaseContext,
  attachments: string[],
): GeneratedLetter {
  const sections: string[] = [];

  // 1. header
  sections.push([
    ctx.clientName,
    ctx.providerName !== ctx.clientName ? `Provider: ${ctx.providerName}` : null,
    `NPI: ${ctx.providerNpi ?? ctx.clientNpiGroup ?? 'on file'}`,
    ...formatAddress(ctx.clientAddress),
    '',
    ctx.asOf,
  ].filter((x): x is string => x != null).join('\n'));

  // 2. payer + appeal address
  sections.push([
    ctx.payerName,
    'Attn: Appeals Department',
    ...(ctx.appealAddress ? ctx.appealAddress.split(/,\s*/) : ['[appeal address on file]']),
  ].join('\n'));

  // 3. RE line
  sections.push([
    `RE: Appeal of claim determination`,
    `    Patient:          ${ctx.patientFirstName} ${ctx.patientLastName}`,
    `    Date of birth:    ${ctx.patientDob ?? 'on file'}`,
    `    Claim number:     ${ctx.claimNumberInternal}${ctx.claimNumberPayer ? ` (payer claim number ${ctx.claimNumberPayer})` : ''}`,
    `    Date of service:  ${ctx.dateOfService}`,
    `    Amount in dispute: ${usd(ctx.recoveryOpportunity)}`,
  ].join('\n'));

  // 4. opening
  sections.push(
    `Dear Appeals Reviewer:\n\n`
    + `On behalf of ${ctx.clientName}, we are appealing the determination on the claim referenced above`
    + `${ctx.denialReasonCode ? `, denied under reason code ${ctx.denialReasonCode}` : ''}. `
    + `This letter and its enclosures constitute a formal request for review and reprocessing.`,
  );

  // 5. category body
  sections.push(body(ctx).join('\n\n'));

  // 6. closing with deadline
  sections.push(
    `We request a written determination on this appeal within the timeframe required by the plan and applicable law`
    + `${ctx.deadlineDate ? `, and note that this appeal is submitted ahead of the applicable appeal deadline of ${ctx.deadlineDate}` : ''}. `
    + `If additional information is required, please contact our office. `
    + `We request that payment of ${usd(ctx.recoveryOpportunity)} be issued upon completion of your review.`,
  );

  // 7. signature block
  sections.push([
    'Sincerely,',
    '',
    '______________________________',
    ctx.providerName,
    ctx.clientName,
    `NPI: ${ctx.providerNpi ?? ctx.clientNpiGroup ?? 'on file'}`,
  ].join('\n'));

  // 8. attachments
  sections.push([
    'Enclosures:',
    ...attachments.map((a, i) => `  ${i + 1}. ${a}`),
  ].join('\n'));

  return {
    fileName: `appeal-letter-${ctx.claimNumberInternal}-${ctx.asOf}.txt`,
    content: sections.join('\n\n') + '\n',
  };
}
