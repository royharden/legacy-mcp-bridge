// LEGACY01 report section: INQUIRY, LIST, HISTORY, AGING and LAYOUT. Each returns the body lines
// (without page headers) and an optional column heading; legacy.mjs paginates and prints.

import {
  loadAccounts,
  loadTransactions,
  ACCT_FILE,
  TRAN_FILE,
  ACCT_RECLEN,
  TRAN_RECLEN,
} from "./files.mjs";
import { editMoney, editCount, editDate, editRate, editTaxId, monthlyInterest } from "./edit.mjs";
import {
  buildLine,
  headingLine,
  TRAILER,
  END_OF_REPORT,
  INQUIRY_LINES,
  LIST_LINES,
  HISTORY_LINES,
  AGING_LINES,
  AGING_POINTERS_PER_LINE,
  LAYOUT_LINES,
} from "./print.mjs";

function trailerLine(scan) {
  return buildLine("TRL", TRAILER.TRL, {
    file: scan.file,
    records_read: editCount(scan.recordsRead, 7),
    skipped_tail_bytes: editCount(scan.tailBytes, 2),
    duplicates: editCount(scan.duplicates, 5),
  });
}

function endLine() {
  return buildLine("END", END_OF_REPORT.END, {});
}

function pointer(file, recordNo) {
  return file + "#" + recordNo;
}

// ---------------------------------------------------------------- INQUIRY
export function inquiry(view, acctId) {
  const scan = loadAccounts(view);
  const body = [];
  let found = null;
  for (const a of scan.accounts) {
    if (a.id === acctId) {
      found = a;
      break;
    }
  }
  if (found === null) {
    body.push(buildLine("NFD", INQUIRY_LINES.NFD, { acct_id: acctId }));
  } else {
    body.push(
      buildLine("AC1", INQUIRY_LINES.AC1, {
        source: pointer(ACCT_FILE, found.recordNo),
        acct_id: found.id,
        name: found.name,
        status: found.status,
        raw_status: found.rawStatus,
        open_date: editDate(found.openDate),
        balance: editMoney(found.balance, 15),
        credit_limit: editMoney(found.creditLimit, 13),
        rate: editRate(found.rate),
        tax_id: editTaxId(found.taxIdRaw),
      }),
    );
    body.push(
      buildLine("AC2", INQUIRY_LINES.AC2, {
        acct_id: found.id,
        memo: found.memo,
        monthly_interest: editMoney(monthlyInterest(found.balance, found.rate), 15),
      }),
    );
  }
  body.push(trailerLine(scan));
  body.push(endLine());
  return { body, heading: null };
}

// ---------------------------------------------------------------- LIST
export function list(view, status, prefix) {
  const scan = loadAccounts(view);
  const body = [];
  body.push(buildLine("SEL", LIST_LINES.SEL, { status, prefix: prefix === null ? "" : prefix }));
  let count = 0;
  let total = 0n;
  for (const a of scan.accounts) {
    if (a.status !== status) {
      continue;
    }
    if (prefix !== null && !a.name.startsWith(prefix)) {
      continue;
    }
    count++;
    if (a.balance !== null) {
      total += a.balance;
    }
    body.push(
      buildLine("DTL", LIST_LINES.DTL, {
        source: pointer(ACCT_FILE, a.recordNo),
        acct_id: a.id,
        name: a.name,
        status: a.status,
        raw_status: a.rawStatus,
        open_date: editDate(a.openDate),
        balance: editMoney(a.balance, 15),
      }),
    );
  }
  body.push(
    buildLine("FTR", LIST_LINES.FTR, {
      matched_count: editCount(count, 7),
      balance_total: editMoney(total, 22),
    }),
  );
  body.push(trailerLine(scan));
  body.push(endLine());
  return { body, heading: headingLine(LIST_LINES.DTL) };
}

// ---------------------------------------------------------------- HISTORY
export function history(view, acctId, from, to) {
  const scan = loadTransactions(view);
  const body = [];
  body.push(
    buildLine("SEL", HISTORY_LINES.SEL, { acct_id: acctId, from: editDate(from), to: editDate(to) }),
  );
  let count = 0;
  let debits = 0n;
  let credits = 0n;
  for (const t of scan.trans) {
    if (t.acctId !== acctId) {
      continue;
    }
    if (t.date.kind !== "date" || t.date.key < from.key || t.date.key > to.key) {
      continue;
    }
    count++;
    if (t.amount !== null) {
      if (t.type === "D") {
        debits += t.amount;
      } else if (t.type === "C") {
        credits += t.amount;
      }
    }
    body.push(
      buildLine("DTL", HISTORY_LINES.DTL, {
        source: pointer(TRAN_FILE, t.recordNo),
        tran_id: t.id,
        acct_id: t.acctId,
        tran_date: editDate(t.date),
        tran_type: t.type,
        tran_status: t.status,
        amount: editMoney(t.amount, 13),
        desc: t.desc,
      }),
    );
  }
  body.push(
    buildLine("FTR", HISTORY_LINES.FTR, {
      matched_count: editCount(count, 7),
      debit_total: editMoney(debits, 22),
      credit_total: editMoney(credits, 22),
    }),
  );
  body.push(trailerLine(scan));
  body.push(endLine());
  return { body, heading: headingLine(HISTORY_LINES.DTL) };
}

// ---------------------------------------------------------------- AGING
export const BUCKET_LABELS = ["0", "1-30", "31-60", "61-90", ">90"];

// 30E/360: 360*(Y2-Y1) + 30*(M2-M1) + min(D2,30) - min(D1,30); no February adjustment.
export function days30E360(d1, d2) {
  return 360 * (d2.y - d1.y) + 30 * (d2.m - d1.m) + Math.min(d2.d, 30) - Math.min(d1.d, 30);
}

export function bucketIndex(days) {
  if (days <= 0) {
    return 0;
  }
  if (days <= 30) {
    return 1;
  }
  if (days <= 60) {
    return 2;
  }
  if (days <= 90) {
    return 3;
  }
  return 4;
}

export function aging(view, asOf) {
  const scan = loadTransactions(view);
  const counts = [0, 0, 0, 0, 0];
  const totals = [0n, 0n, 0n, 0n, 0n];
  const pointers = [[], [], [], [], []];
  for (const t of scan.trans) {
    if (t.status !== "O" || t.type !== "D") {
      continue;
    }
    if (t.date.kind !== "date" || t.date.key > asOf.key || t.amount === null) {
      continue;
    }
    const b = bucketIndex(days30E360(t.date, asOf));
    counts[b]++;
    totals[b] += t.amount;
    pointers[b].push(pointer(TRAN_FILE, t.recordNo));
  }
  const body = [];
  body.push(buildLine("SEL", AGING_LINES.SEL, { as_of: editDate(asOf) }));
  let allCount = 0;
  let allTotal = 0n;
  for (let b = 0; b < BUCKET_LABELS.length; b++) {
    allCount += counts[b];
    allTotal += totals[b];
    body.push(
      buildLine("BKT", AGING_LINES.BKT, {
        bucket: BUCKET_LABELS[b],
        count: editCount(counts[b], 7),
        total: editMoney(totals[b], 22),
      }),
    );
  }
  body.push(
    buildLine("FTR", AGING_LINES.FTR, {
      matched_count: editCount(allCount, 7),
      amount_total: editMoney(allTotal, 22),
    }),
  );
  for (let b = 0; b < BUCKET_LABELS.length; b++) {
    const ptrs = pointers[b];
    for (let i = 0; i < ptrs.length; i += AGING_POINTERS_PER_LINE) {
      const values = { bucket: BUCKET_LABELS[b] };
      for (let k = 0; k < AGING_POINTERS_PER_LINE; k++) {
        values["source_" + (k + 1)] = i + k < ptrs.length ? ptrs[i + k] : "";
      }
      body.push(buildLine("PTR", AGING_LINES.PTR, values));
    }
  }
  body.push(trailerLine(scan));
  body.push(endLine());
  return { body, heading: null };
}

// ---------------------------------------------------------------- LAYOUT
// The oracle's own field dictionary, transcribed from the copybooks (offsets zero-based).
const ACCT_FIELDS = [
  ["ACCT-ID", 0, 10, "zoned", 0, "-", "9(10)"],
  ["ACCT-NAME", 10, 25, "alnum", 0, "-", "X(25)"],
  ["ACCT-STATUS", 35, 1, "alnum", 0, "-", "X"],
  ["OPEN-DATE", 36, 6, "zoned", 0, "YYMMDD/50", "9(6)"],
  ["BALANCE", 42, 11, "zoned_signed", 2, "-", "S9(9)V99"],
  ["CREDIT-LIMIT", 53, 5, "packed", 2, "-", "S9(7)V99 COMP-3"],
  ["RATE", 58, 4, "zoned", 3, "-", "9V999"],
  ["TAX-ID", 62, 9, "alnum", 0, "-", "X(9)"],
  ["MEMO", 71, 25, "alnum", 0, "-", "X(25)"],
  ["FILLER", 96, 4, "alnum", 0, "-", "X(4)"],
];

const TRAN_FIELDS = [
  ["TRAN-ID", 0, 10, "zoned", 0, "-", "9(10)"],
  ["ACCT-ID", 10, 10, "zoned", 0, "-", "9(10)"],
  ["TRAN-DATE", 20, 6, "zoned", 0, "YYMMDD/50", "9(6)"],
  ["TRAN-TYPE", 26, 1, "alnum", 0, "-", "X"],
  ["AMOUNT", 27, 9, "zoned_signed", 2, "-", "S9(7)V99"],
  ["TRAN-STATUS", 36, 1, "alnum", 0, "-", "X"],
  ["DESC", 37, 30, "alnum", 0, "-", "X(30)"],
  ["FILLER", 67, 13, "alnum", 0, "-", "X(13)"],
];

const POLICIES = [
  ["MASKING", "MASK-TAXID-LAST4"],
  ["STATUS", "STATUS-X-IS-CLOSED"],
  ["DUPLICATES", "DUP-FIRST-WINS"],
  ["TAIL", "TAIL-SKIP-COUNT"],
  ["INTEREST", "INT-TRUNC-12000"],
  ["AGING", "AGE-30E360-OPEN-DEBIT"],
];

function fieldLines(record, recLen, fields) {
  const lines = [
    buildLine("REC", LAYOUT_LINES.REC, {
      record,
      length: editCount(recLen, 3),
      fields: editCount(fields.length, 2),
    }),
  ];
  for (const [field, offset, length, type, scale, window, pic] of fields) {
    lines.push(
      buildLine("FLD", LAYOUT_LINES.FLD, {
        record,
        field,
        offset: editCount(offset, 3),
        length: editCount(length, 3),
        type,
        scale: editCount(scale, 1),
        date_window: window,
        pic,
      }),
    );
  }
  return lines;
}

function diagnosticLine(scan) {
  return buildLine("DIA", LAYOUT_LINES.DIA, {
    record: scan.file,
    records_read: editCount(scan.recordsRead, 7),
    skipped_tail_bytes: editCount(scan.tailBytes, 2),
    duplicate_keys: editCount(scan.duplicates, 5),
  });
}

export function layout(view) {
  const acct = loadAccounts(view);
  const tran = loadTransactions(view);
  const body = [];
  body.push(...fieldLines(ACCT_FILE, ACCT_RECLEN, ACCT_FIELDS));
  body.push(...fieldLines(TRAN_FILE, TRAN_RECLEN, TRAN_FIELDS));
  for (const [policy, value] of POLICIES) {
    body.push(buildLine("POL", LAYOUT_LINES.POL, { policy, value }));
  }
  body.push(diagnosticLine(acct));
  body.push(diagnosticLine(tran));
  body.push(trailerLine(acct));
  body.push(trailerLine(tran));
  body.push(endLine());
  return { body, heading: null };
}
