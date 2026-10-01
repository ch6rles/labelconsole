import { z } from 'zod';

/** What Claude must return for a contract. Every field nullable: only what the document says. */
export const ContractTermsSchema = z.object({
  agreementType: z.string().nullable().describe('e.g. Exclusive recording agreement, EP license, Single license, Distribution agreement, Publishing administration'),
  parties: z.array(z.object({ name: z.string(), role: z.string().describe('artist, label, publisher, producer, manager...') })),
  effectiveDate: z.string().nullable().describe('ISO date YYYY-MM-DD'),
  termDescription: z.string().nullable().describe('the term in words, e.g. "3 years" or "2 albums or 4 years"'),
  termEndDate: z.string().nullable().describe('ISO date when the term ends, if stated or computable from the effective date'),
  territory: z.string().nullable(),
  royaltyArtistPct: z.number().nullable().describe('artist share in percent, e.g. 40'),
  royaltyLabelPct: z.number().nullable(),
  royaltyBasis: z.string().nullable().describe('e.g. net receipts, gross receipts, PPD'),
  advanceAmount: z.number().nullable(),
  advanceCurrency: z.string().nullable(),
  recoupment: z.string().nullable().describe('what is recoupable and from what'),
  options: z.array(z.object({ description: z.string(), exerciseBy: z.string().nullable().describe('ISO date') })),
  keyDates: z.array(z.object({ kind: z.enum(['expiry', 'option', 'renewal', 'notice', 'payment', 'other']), date: z.string().describe('ISO date'), description: z.string() })),
  releasesCovered: z.array(z.string()).describe('titles of releases or tracks the agreement covers'),
  notes: z.string().nullable().describe('anything unusual a label manager should know, in one or two sentences'),
});

export const CONTRACT_SYSTEM = `You read music-industry agreements (recording, licence, distribution, publishing, producer, management) for a record label and extract their commercial terms.

Report only what the document states. When a term is absent or ambiguous, return null (or an empty list) rather than guessing. Convert dates to ISO YYYY-MM-DD; when only a month and year are given, use the first day of the month. Percentages are numbers without the % sign. Put every deadline the label must act on (option exercise windows, notice periods, renewal or expiry) into keyDates.

Your output is shown to a person for confirmation before anything is applied, so precision matters more than completeness.`;

/** A statement PDF's line items, when the distributor only sends PDFs. */
export const StatementLinesSchema = z.object({
  distributor: z.string().nullable(),
  currency: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  lines: z.array(
    z.object({
      source: z.string(),
      territory: z.string().nullable(),
      isrc: z.string().nullable(),
      upc: z.string().nullable(),
      trackTitle: z.string().nullable(),
      units: z.number(),
      grossAmount: z.number().nullable(),
      netAmount: z.number(),
    }),
  ),
});

export const STATEMENT_SYSTEM = `You transcribe royalty statements from record distributors into line items. Copy figures exactly as printed; do not total, round or infer missing values. Use one line per store/territory/track row printed in the statement. Amounts are numbers in the statement currency.`;

export const STATEMENT_LINES_HINT = 'Transcribe every revenue line in this royalty statement.';
