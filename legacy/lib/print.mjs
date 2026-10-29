// LEGACY01 print section: the fixed-column line types of every report (1-based start columns), the
// line builder and the 55-line paginator. Every printed line is exactly 132 characters plus LF.
// PRINTSPEC.md documents these same columns for humans.

export const LINE_WIDTH = 132;
export const PAGE_LENGTH = 55;
export const PROGRAM_NAME = "LEGACY01";

function col(name, start, width, kind) {
  return { name, start, width, kind };
}

function lit(name, start, value) {
  return { name, start, width: value.length, kind: "literal", value };
}

// Columns 1-3 of every line hold the line-type code; column 4 is always blank.

export const PAGE_HEADER = {
  HDR: [
    lit("program", 5, "LEGACY01"),
    col("report", 14, 8, "code"),
    col("view", 23, 8, "code"),
    lit("run_ts_label", 32, "RUN-TS"),
    col("run_ts", 39, 19, "volatile"),
    lit("page_label", 59, "PAGE"),
    col("page", 64, 5, "count"),
  ],
};

export const TRAILER = {
  TRL: [
    col("file", 5, 8, "code"),
    lit("records_label", 14, "RECORDS READ"),
    col("records_read", 27, 7, "count"),
    lit("tail_label", 35, "SKIPPED-TAIL-BYTES"),
    col("skipped_tail_bytes", 54, 2, "count"),
    lit("dup_label", 57, "DUPLICATES"),
    col("duplicates", 68, 5, "count"),
  ],
};

export const END_OF_REPORT = {
  END: [lit("message", 5, "END OF REPORT")],
};

export const INQUIRY_LINES = {
  AC1: [
    col("source", 5, 13, "pointer"),
    col("acct_id", 19, 10, "code"),
    col("name", 30, 25, "text"),
    col("status", 56, 1, "code"),
    col("raw_status", 58, 1, "code"),
    col("open_date", 60, 10, "date"),
    col("balance", 71, 15, "money"),
    col("credit_limit", 87, 13, "money"),
    col("rate", 101, 5, "rate"),
    col("tax_id", 107, 9, "taxid"),
  ],
  AC2: [
    col("acct_id", 5, 10, "code"),
    col("memo", 16, 25, "text"),
    col("monthly_interest", 42, 15, "money"),
  ],
  NFD: [
    col("acct_id", 5, 10, "code"),
    lit("message", 16, "ACCOUNT NOT FOUND"),
  ],
};

export const LIST_LINES = {
  SEL: [
    lit("status_label", 5, "STATUS"),
    col("status", 12, 1, "code"),
    lit("prefix_label", 14, "PREFIX"),
    col("prefix", 21, 25, "text"),
  ],
  DTL: [
    col("source", 5, 13, "pointer"),
    col("acct_id", 19, 10, "code"),
    col("name", 30, 25, "text"),
    col("status", 56, 1, "code"),
    col("raw_status", 58, 1, "code"),
    col("open_date", 60, 10, "date"),
    col("balance", 71, 15, "money"),
  ],
  FTR: [
    lit("matched_label", 5, "MATCHED"),
    col("matched_count", 13, 7, "count"),
    lit("total_label", 21, "BALANCE-TOTAL"),
    col("balance_total", 35, 22, "money"),
  ],
};

export const HISTORY_LINES = {
  SEL: [
    lit("account_label", 5, "ACCOUNT"),
    col("acct_id", 13, 10, "code"),
    lit("from_label", 24, "FROM"),
    col("from", 29, 10, "date"),
    lit("to_label", 40, "TO"),
    col("to", 43, 10, "date"),
  ],
  DTL: [
    col("source", 5, 13, "pointer"),
    col("tran_id", 19, 10, "code"),
    col("acct_id", 30, 10, "code"),
    col("tran_date", 41, 10, "date"),
    col("tran_type", 52, 1, "code"),
    col("tran_status", 54, 1, "code"),
    col("amount", 56, 13, "money"),
    col("desc", 70, 30, "text"),
  ],
  FTR: [
    lit("matched_label", 5, "MATCHED"),
    col("matched_count", 13, 7, "count"),
    lit("debit_label", 21, "DEBIT-TOTAL"),
    col("debit_total", 33, 22, "money"),
    lit("credit_label", 56, "CREDIT-TOTAL"),
    col("credit_total", 69, 22, "money"),
  ],
};

export const AGING_POINTERS_PER_LINE = 8;

export const AGING_LINES = {
  SEL: [
    lit("as_of_label", 5, "AS-OF"),
    col("as_of", 11, 10, "date"),
  ],
  BKT: [
    col("bucket", 5, 5, "code"),
    lit("count_label", 11, "COUNT"),
    col("count", 17, 7, "count"),
    lit("total_label", 25, "TOTAL"),
    col("total", 31, 22, "money"),
  ],
  FTR: [
    lit("matched_label", 5, "MATCHED"),
    col("matched_count", 13, 7, "count"),
    lit("total_label", 21, "AMOUNT-TOTAL"),
    col("amount_total", 34, 22, "money"),
  ],
  PTR: [
    col("bucket", 5, 5, "code"),
    col("source_1", 11, 13, "pointer"),
    col("source_2", 25, 13, "pointer"),
    col("source_3", 39, 13, "pointer"),
    col("source_4", 53, 13, "pointer"),
    col("source_5", 67, 13, "pointer"),
    col("source_6", 81, 13, "pointer"),
    col("source_7", 95, 13, "pointer"),
    col("source_8", 109, 13, "pointer"),
  ],
};

export const LAYOUT_LINES = {
  REC: [
    col("record", 5, 8, "code"),
    lit("length_label", 14, "LENGTH"),
    col("length", 21, 3, "count"),
    lit("fields_label", 25, "FIELDS"),
    col("fields", 32, 2, "count"),
  ],
  FLD: [
    col("record", 5, 8, "code"),
    col("field", 14, 12, "text"),
    col("offset", 27, 3, "count"),
    col("length", 31, 3, "count"),
    col("type", 35, 12, "code"),
    col("scale", 48, 1, "count"),
    col("date_window", 50, 10, "code"),
    col("pic", 61, 20, "text"),
  ],
  POL: [
    col("policy", 5, 16, "code"),
    col("value", 22, 24, "code"),
  ],
  DIA: [
    col("record", 5, 8, "code"),
    lit("records_label", 14, "RECORDS-READ"),
    col("records_read", 27, 7, "count"),
    lit("tail_label", 35, "SKIPPED-TAIL-BYTES"),
    col("skipped_tail_bytes", 54, 2, "count"),
    lit("dup_label", 57, "DUPLICATE-KEYS"),
    col("duplicate_keys", 72, 5, "count"),
  ],
};

function place(chars, start, text, width) {
  for (let i = 0; i < width; i++) {
    chars[start - 1 + i] = i < text.length ? text[i] : " ";
  }
}

// Builds one 132-character line. Values for money/count columns arrive already edited to width;
// every other value is left-aligned, blank-padded and cut at the column width.
export function buildLine(lineType, columns, values) {
  const chars = new Array(LINE_WIDTH).fill(" ");
  place(chars, 1, lineType, 3);
  for (const c of columns) {
    const text = c.kind === "literal" ? c.value : values[c.name] === undefined ? "" : String(values[c.name]);
    place(chars, c.start, text, c.width);
  }
  return chars.join("");
}

// Column heading line: each detail column's name upper-cased, cut at its width, at its start column.
export function headingLine(columns) {
  const values = {};
  const cols = columns.map((c) => {
    values[c.name] = c.name.toUpperCase();
    return { name: c.name, start: c.start, width: c.width, kind: "text" };
  });
  return buildLine("COL", cols, values);
}

// Splits body lines into 55-line pages: HDR, optional COL heading, then body lines.
export function paginate(reportName, viewName, runTs, bodyLines, heading) {
  const perPage = PAGE_LENGTH - 1 - (heading ? 1 : 0);
  const out = [];
  let page = 0;
  let i = 0;
  do {
    page++;
    out.push(
      buildLine("HDR", PAGE_HEADER.HDR, {
        report: reportName,
        view: viewName.toUpperCase(),
        run_ts: runTs,
        page: String(page).padStart(5, "0"),
      }),
    );
    if (heading) {
      out.push(heading);
    }
    const stop = Math.min(bodyLines.length, i + perPage);
    for (; i < stop; i++) {
      out.push(bodyLines[i]);
    }
  } while (i < bodyLines.length);
  return out.join("\n") + "\n";
}
