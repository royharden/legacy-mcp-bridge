// src/bridge/schemas.ts — zod contracts of the five tools: strict inputs (unknown fields rejected) and output schemas for
// the structured result. Every record carries a one-based `source`; free text is {text, untrusted_text: true}; money is a
// safe integer in minor units; tax ids can only leave masked (`***-**-` + last four).
import { z } from "zod";
import { AccountId, IsoDate, limit } from "../mcpkit/validate.ts";

export const ACCOUNTS_FIND_MAX = 50;
export const ACCOUNTS_FIND_DEFAULT = 20;
export const TRANSACTIONS_LIST_MAX = 100;
export const TRANSACTIONS_LIST_DEFAULT = 50;
/** Contributing source pointers listed per aging bucket before the list is capped. */
export const AGING_SOURCES_PER_BUCKET = 100;

const Cursor = z
  .string()
  .min(1, "cursor must not be empty")
  .max(1024, "cursor is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "cursor must be a token returned by this tool");

const NamePrefix = z
  .string()
  .min(1, "name_prefix must not be empty")
  .max(25, "name_prefix is at most 25 characters")
  .regex(/^[\x20-\x7E]+$/, "name_prefix must be printable ASCII");

const Status = z.enum(["A", "S", "C"]);

// ---- inputs ----

export const DescribeLayoutsInput = z.object({}).strict();

export const AccountGetInput = z.object({ account_id: AccountId }).strict();

export const AccountsFindInput = z
  .object({
    status: Status.optional(),
    name_prefix: NamePrefix.optional(),
    limit: limit(ACCOUNTS_FIND_MAX).optional(),
    cursor: Cursor.optional(),
  })
  .strict();

export const TransactionsListInput = z
  .object({
    account_id: AccountId,
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    limit: limit(TRANSACTIONS_LIST_MAX).optional(),
    cursor: Cursor.optional(),
  })
  .strict();

export const AgingSummaryInput = z.object({ as_of: IsoDate }).strict();

export type AccountsFindArgs = z.output<typeof AccountsFindInput>;
export type TransactionsListArgs = z.output<typeof TransactionsListInput>;

// ---- outputs ----

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const Minor = z.number().int().safe();
const Count = z.number().int().min(0);
const UntrustedText = z.object({ text: z.string(), untrusted_text: z.literal(true) }).strict();
const AcctSource = z.string().regex(/^ACCTMSTR#[1-9][0-9]*$/);
const TransSource = z.string().regex(/^TRANS#[1-9][0-9]*$/);
const MaskedTaxId = z.string().regex(/^(\*\*\*-\*\*-[\x20-\x7E]{1,4})?$/, "tax_id must be masked");

const envelope = {
  warnings: z.array(z.string()),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
};

export const AccountRow = z
  .object({
    source: AcctSource,
    account_id: z.string().regex(/^[0-9]{10}$/),
    name: UntrustedText,
    status: Status,
    open_date: z.string().regex(ISO_DATE_RE).nullable(),
    balance_minor: Minor,
    credit_limit_minor: Minor,
    rate_thousandths: Count,
    tax_id: MaskedTaxId,
    memo: UntrustedText,
    monthly_interest_minor: Minor,
  })
  .strict();

export const TransactionRow = z
  .object({
    source: TransSource,
    tran_id: z.string().regex(/^[0-9]{10}$/),
    account_id: z.string().regex(/^[0-9]{10}$/),
    date: z.string().regex(ISO_DATE_RE),
    type: z.enum(["D", "C"]),
    amount_minor: Minor,
    status: z.enum(["O", "P"]),
    desc: UntrustedText,
  })
  .strict();

export const AgingBucketRow = z
  .object({
    bucket: z.enum(["0", "1-30", "31-60", "61-90", ">90"]),
    count: Count,
    amount_minor: Minor,
    sources: z.array(TransSource),
    omitted_sources: Count,
  })
  .strict();

const Diagnostics = z
  .object({ records_read: Count, skipped_tail_bytes: Count, duplicate_keys: Count })
  .strict();

const LayoutFieldOut = z
  .object({
    name: z.string(),
    property: z.string().nullable(),
    offset: Count,
    length: z.number().int().min(1),
    type: z.enum(["alnum", "zoned", "packed", "date_yymmdd", "lowvalues"]),
    digits: z.number().int().min(1).nullable(),
    scale: Count,
    signed: z.boolean(),
    key: z.boolean(),
    exposed: z.boolean(),
    untrusted_text: z.boolean(),
    mask: z.literal("last4").nullable(),
    date_window: z.object({ pivot: Count, never: z.string().nullable() }).strict().nullable(),
    meaning: z.string().min(1),
    quirk: z.string().min(1),
    copybook: z.object({ file: z.string(), line: z.number().int().min(1), pic: z.string() }).strict(),
  })
  .strict();

const LayoutOut = z
  .object({
    record: z.enum(["ACCTMSTR", "TRANS"]),
    file: z.string(),
    copybook: z.string(),
    record_length: z.number().int().min(1),
    fields: z.array(LayoutFieldOut),
    diagnostics: Diagnostics,
  })
  .strict();

export const DescribeLayoutsOutput = z
  .object({
    data: z
      .object({
        layouts: z.array(LayoutOut),
        rules: z
          .object({
            tax_id_mask: z.string(),
            status_x: z.string(),
            duplicates: z.string(),
            truncated_tail: z.string(),
            interest: z.string(),
            aging: z.string(),
            untrusted_text: z.string(),
            source_pointers: z.string(),
          })
          .strict(),
      })
      .strict(),
    ...envelope,
  })
  .strict();

export const AccountGetOutput = z.object({ data: AccountRow, ...envelope }).strict();

export const AccountsFindOutput = z
  .object({ data: z.array(AccountRow), ...envelope, matched_count: Count, balance_total_minor: Minor })
  .strict();

export const TransactionsListOutput = z
  .object({
    data: z.array(TransactionRow),
    ...envelope,
    matched_count: Count,
    debit_total_minor: Minor,
    credit_total_minor: Minor,
  })
  .strict();

export const AgingSummaryOutput = z
  .object({
    data: z.object({ as_of: z.string().regex(ISO_DATE_RE), buckets: z.array(AgingBucketRow) }).strict(),
    ...envelope,
    total_count: Count,
    total_amount_minor: Minor,
    source_complete: z.boolean(),
    omitted_sources: Count,
  })
  .strict();

export type AccountRowOut = z.output<typeof AccountRow>;
export type TransactionRowOut = z.output<typeof TransactionRow>;
export type AgingBucketOut = z.output<typeof AgingBucketRow>;
export type DescribeLayoutsOut = z.output<typeof DescribeLayoutsOutput>;
