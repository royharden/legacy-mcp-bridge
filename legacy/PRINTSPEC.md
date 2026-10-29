# LEGACY01 print specification

Human description of every report the stand-in legacy program `legacy/legacy.mjs` prints. The machine copy
is `parity/printspec.json` (version 1); the two list exactly the same columns. The program itself carries its
own copy of these columns as constants in `legacy/lib/print.mjs` and never reads either document.

## Invocation

```
node legacy/legacy.mjs [--view attacked|clean] <command>
  INQUIRY <acct10>
  LIST STATUS <A|S|C> [PREFIX <text 1-25 chars>]
  HISTORY <acct10> <yyyy-mm-dd> <yyyy-mm-dd>        (from <= to, real calendar dates)
  AGING <yyyy-mm-dd>
  LAYOUT
  POST <acct10> <D|C> <amount 0.01-9999999.99>      (writes to an OS temp copy only)
```

`--view` (default `attacked`) selects `fixtures/legacy/` or `fixtures/legacy-clean/` under the repository root.
`LEGACY_RUN_TS` (optional, 1-19 printable characters) replaces the run timestamp so output is byte-deterministic.

| Exit | Meaning |
|---|---|
| 0 | report printed (INQUIRY of an unknown account prints an `NFD` line and exits 0) |
| 1 | unexpected internal error |
| 2 | usage / argument error: message on stderr, nothing on stdout |
| 3 | data file missing or unreadable |
| 4 | POST refused (unknown account, non-numeric or overflowing balance) |

## Page and line rules

- Every line is exactly 132 characters followed by LF. Columns are 1-based.
- Columns 1-3 hold the line-type code; column 4 is blank; unused columns are blank.
- A page is at most 55 lines: one `HDR` line, then (LIST and HISTORY only) one `COL` heading line, then body
  lines. A report with no body still prints one page.
- `COL` heading: for each column of the report's `DTL` line, the column name upper-cased and cut at its width,
  placed at its start column. Parsers skip it.
- Every report (except POST) ends with one `TRL` line per data file read and then one `END` line. A report with
  no `END` line is truncated.

## Edit pictures (column kinds)

| Kind | Rule |
|---|---|
| literal | fixed text shown in backticks |
| text | left-aligned, blank-padded; low-values print as blanks, other non-printables as `?`; trailing blanks are padding; internal double spaces kept |
| code | left-aligned, blank-padded code or identifier |
| count | unsigned integer zero-filled to width (`0001000`); all `*` if it does not fit |
| money | right-aligned minor units edited `Z,ZZZ,ZZ9.99-`: commas, point, 2 decimals, trailing sign (`-` negative, blank otherwise); all `*` on overflow; all `?` when the field is not numeric |
| date | `yyyy-mm-dd`; `NEVER` for `000000`; `INVALID` for a non-numeric or non-calendar date |
| rate | `9.999` annual rate from thousandths (`0035` prints `0.035`); `?????` when not numeric |
| taxid | the 9-character tax id exactly as stored, UNMASKED (text rules for non-printables); blank when blank. The bridge masks it (`***-**-1234`); parity checks bridge value = mask(oracle value) as an `expected_divergence`, and harness diffs mask it |
| pointer | one-based physical record `ACCTMSTR#n` / `TRANS#n` (`ACCTMSTR#1` is bytes 0-99) |
| volatile | run-dependent; parity ignores it (`ignore_volatile`) |

## Data semantics the reports apply

- Zoned signed fields use a trailing overpunch: `{` +0, `A`-`I` +1..+9, `}` -0, `J`-`R` -1..-9; a plain digit in
  the last byte is positive. COMP-3 sign nibble `C`/`F` positive, `D` negative; digit nibbles 0-9. Anything else
  makes the field not numeric (`?` fill, excluded from totals and AGING; the row still counts in LIST/HISTORY).
- Dates are YYMMDD with pivot 50 (`00`-`49` => 20YY, `50`-`99` => 19YY).
- Effective status: `A`, `S`, `C` as stored; undocumented `X` => `C`; any other code => `?` (never selected).
- First physical record of a key wins (ACCT-ID in ACCTMSTR, TRAN-ID in TRANS); later duplicates are counted
  in `DUPLICATES` and ignored by every report. Bytes after the last whole record are a truncated tail: skipped,
  counted in `SKIPPED-TAIL-BYTES`. `RECORDS READ` counts every whole record, duplicates included.
- Monthly interest = trunc(balance_minor x rate_thousandths / 12000) toward zero.
- LIST selects on effective status and, with PREFIX, on the decoded name starting with the prefix (case-sensitive).
- HISTORY selects ACCT-ID equal and a valid TRAN-DATE within [from, to]; debit total sums `D` amounts, credit
  total sums `C` amounts (signed as stored).
- AGING selects TRAN-STATUS `O`, TRAN-TYPE `D`, valid TRAN-DATE <= as-of, numeric amount. Days are 30E/360:
  360(Y2-Y1) + 30(M2-M1) + min(D2,30) - min(D1,30). Buckets `0`, `1-30`, `31-60`, `61-90`, `>90`.

## Page header

### PAGE HDR

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| program | 5 | 8 | literal | `LEGACY01` | program name |
| report | 14 | 8 | code | X(8) | INQUIRY, LIST, HISTORY, AGING, LAYOUT (or POST) |
| view | 23 | 8 | code | X(8) | ATTACKED or CLEAN |
| run_ts_label | 32 | 6 | literal | `RUN-TS` | label |
| run_ts | 39 | 19 | volatile | X(19) | run timestamp `yyyy-mm-dd hh:mm:ss` (UTC) or `LEGACY_RUN_TS` |
| page_label | 59 | 4 | literal | `PAGE` | label |
| page | 64 | 5 | count | 9(5) | page number from 00001 |

## Trailer and end of report

### TRAILER TRL

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| file | 5 | 8 | code | X(8) | ACCTMSTR or TRANS |
| records_label | 14 | 12 | literal | `RECORDS READ` | label |
| records_read | 27 | 7 | count | 9(7) | whole records read, duplicates included |
| tail_label | 35 | 18 | literal | `SKIPPED-TAIL-BYTES` | label |
| skipped_tail_bytes | 54 | 2 | count | 9(2) | bytes after the last whole record |
| dup_label | 57 | 10 | literal | `DUPLICATES` | label |
| duplicates | 68 | 5 | count | 9(5) | records ignored because their key was already seen |

### END END

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| message | 5 | 13 | literal | `END OF REPORT` | last line of every parsed report |

## INQUIRY

Order: `AC1`, `AC2` (or `NFD` when the account is unknown); `TRL` ACCTMSTR; `END`. No heading line.

### INQUIRY AC1

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| source | 5 | 13 | pointer | X(13) | `ACCTMSTR#n` of the winning record |
| acct_id | 19 | 10 | code | 9(10) | ACCT-ID |
| name | 30 | 25 | text | X(25) | ACCT-NAME (untrusted text) |
| status | 56 | 1 | code | X | effective status A/S/C/? |
| raw_status | 58 | 1 | code | X | stored ACCT-STATUS |
| open_date | 60 | 10 | date | yyyy-mm-dd | OPEN-DATE or NEVER / INVALID |
| balance | 71 | 15 | money | ZZZ,ZZZ,ZZ9.99- | BALANCE |
| credit_limit | 87 | 13 | money | Z,ZZZ,ZZ9.99- | CREDIT-LIMIT (COMP-3) |
| rate | 101 | 5 | rate | 9.999 | RATE, annual |
| tax_id | 107 | 9 | taxid | X(9) | TAX-ID as stored, unmasked |

### INQUIRY AC2

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| acct_id | 5 | 10 | code | 9(10) | ACCT-ID (repeated) |
| memo | 16 | 25 | text | X(25) | MEMO (untrusted text) |
| monthly_interest | 42 | 15 | money | ZZZ,ZZZ,ZZ9.99- | trunc(balance x rate / 12000) |

### INQUIRY NFD

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| acct_id | 5 | 10 | code | 9(10) | requested ACCT-ID |
| message | 16 | 17 | literal | `ACCOUNT NOT FOUND` | not-found marker |

## LIST

Order: `SEL`; `DTL` per match in physical order; `FTR`; `TRL` ACCTMSTR; `END`. `COL` heading from `DTL`.

### LIST SEL

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| status_label | 5 | 6 | literal | `STATUS` | label |
| status | 12 | 1 | code | X | requested status |
| prefix_label | 14 | 6 | literal | `PREFIX` | label |
| prefix | 21 | 25 | text | X(25) | requested name prefix, blank when none |

### LIST DTL

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| source | 5 | 13 | pointer | X(13) | `ACCTMSTR#n` |
| acct_id | 19 | 10 | code | 9(10) | ACCT-ID |
| name | 30 | 25 | text | X(25) | ACCT-NAME |
| status | 56 | 1 | code | X | effective status |
| raw_status | 58 | 1 | code | X | stored ACCT-STATUS |
| open_date | 60 | 10 | date | yyyy-mm-dd | OPEN-DATE |
| balance | 71 | 15 | money | ZZZ,ZZZ,ZZ9.99- | BALANCE |

### LIST FTR

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| matched_label | 5 | 7 | literal | `MATCHED` | label |
| matched_count | 13 | 7 | count | 9(7) | number of DTL lines |
| total_label | 21 | 13 | literal | `BALANCE-TOTAL` | label |
| balance_total | 35 | 22 | money | Z,ZZZ,ZZZ,ZZZ,ZZZ,ZZ9.99- | sum of numeric balances over the whole match |

## HISTORY

Order: `SEL`; `DTL` per match in physical order; `FTR`; `TRL` TRANS; `END`. `COL` heading from `DTL`.

### HISTORY SEL

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| account_label | 5 | 7 | literal | `ACCOUNT` | label |
| acct_id | 13 | 10 | code | 9(10) | requested ACCT-ID |
| from_label | 24 | 4 | literal | `FROM` | label |
| from | 29 | 10 | date | yyyy-mm-dd | from date (inclusive) |
| to_label | 40 | 2 | literal | `TO` | label |
| to | 43 | 10 | date | yyyy-mm-dd | to date (inclusive) |

### HISTORY DTL

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| source | 5 | 13 | pointer | X(13) | `TRANS#n` |
| tran_id | 19 | 10 | code | 9(10) | TRAN-ID |
| acct_id | 30 | 10 | code | 9(10) | ACCT-ID |
| tran_date | 41 | 10 | date | yyyy-mm-dd | TRAN-DATE |
| tran_type | 52 | 1 | code | X | D or C |
| tran_status | 54 | 1 | code | X | O or P |
| amount | 56 | 13 | money | Z,ZZZ,ZZ9.99- | AMOUNT |
| desc | 70 | 30 | text | X(30) | DESC (untrusted text) |

### HISTORY FTR

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| matched_label | 5 | 7 | literal | `MATCHED` | label |
| matched_count | 13 | 7 | count | 9(7) | number of DTL lines |
| debit_label | 21 | 11 | literal | `DEBIT-TOTAL` | label |
| debit_total | 33 | 22 | money | Z,ZZZ,ZZZ,ZZZ,ZZZ,ZZ9.99- | sum of numeric D amounts over the whole match |
| credit_label | 56 | 12 | literal | `CREDIT-TOTAL` | label |
| credit_total | 69 | 22 | money | Z,ZZZ,ZZZ,ZZZ,ZZZ,ZZ9.99- | sum of numeric C amounts over the whole match |

## AGING

Order: `SEL`; five `BKT` lines in bucket order `0`, `1-30`, `31-60`, `61-90`, `>90` (always all five); `FTR`;
`PTR` lines (bucket order, then physical order, 8 pointers per line, unused slots blank, no line for an empty
bucket); `TRL` TRANS; `END`. No heading line.

### AGING SEL

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| as_of_label | 5 | 5 | literal | `AS-OF` | label |
| as_of | 11 | 10 | date | yyyy-mm-dd | as-of date |

### AGING BKT

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| bucket | 5 | 5 | code | X(5) | bucket label |
| count_label | 11 | 5 | literal | `COUNT` | label |
| count | 17 | 7 | count | 9(7) | rows in the bucket |
| total_label | 25 | 5 | literal | `TOTAL` | label |
| total | 31 | 22 | money | Z,ZZZ,ZZZ,ZZZ,ZZZ,ZZ9.99- | sum of amounts in the bucket |

### AGING FTR

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| matched_label | 5 | 7 | literal | `MATCHED` | label |
| matched_count | 13 | 7 | count | 9(7) | rows over all buckets |
| total_label | 21 | 12 | literal | `AMOUNT-TOTAL` | label |
| amount_total | 34 | 22 | money | Z,ZZZ,ZZZ,ZZZ,ZZZ,ZZ9.99- | sum over all buckets |

### AGING PTR

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| bucket | 5 | 5 | code | X(5) | bucket the pointers belong to |
| source_1 | 11 | 13 | pointer | X(13) | contributing `TRANS#n` |
| source_2 | 25 | 13 | pointer | X(13) | contributing `TRANS#n` |
| source_3 | 39 | 13 | pointer | X(13) | contributing `TRANS#n` |
| source_4 | 53 | 13 | pointer | X(13) | contributing `TRANS#n` |
| source_5 | 67 | 13 | pointer | X(13) | contributing `TRANS#n` |
| source_6 | 81 | 13 | pointer | X(13) | contributing `TRANS#n` |
| source_7 | 95 | 13 | pointer | X(13) | contributing `TRANS#n` |
| source_8 | 109 | 13 | pointer | X(13) | contributing `TRANS#n` |

## LAYOUT

Order: `REC` ACCTMSTR; 10 `FLD`; `REC` TRANS; 8 `FLD`; 6 `POL`; `DIA` ACCTMSTR; `DIA` TRANS; `TRL` ACCTMSTR;
`TRL` TRANS; `END`. No heading line. Field types: `alnum` (X), `zoned` (unsigned display 9), `zoned_signed`
(S9 trailing overpunch), `packed` (COMP-3). Offsets are zero-based. Date window `YYMMDD/50` or `-`.
Policies printed (policy / value): MASKING / MASK-TAXID-LAST4, STATUS / STATUS-X-IS-CLOSED, DUPLICATES /
DUP-FIRST-WINS, TAIL / TAIL-SKIP-COUNT, INTEREST / INT-TRUNC-12000, AGING / AGE-30E360-OPEN-DEBIT.
Parity projection: record, field, offset, length, type, scale, date_window, the policies and the diagnostics.
`pic` is documentation only.

### LAYOUT REC

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| record | 5 | 8 | code | X(8) | ACCTMSTR or TRANS |
| length_label | 14 | 6 | literal | `LENGTH` | label |
| length | 21 | 3 | count | 9(3) | record length in bytes |
| fields_label | 25 | 6 | literal | `FIELDS` | label |
| fields | 32 | 2 | count | 9(2) | number of FLD lines that follow |

### LAYOUT FLD

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| record | 5 | 8 | code | X(8) | owning record |
| field | 14 | 12 | text | X(12) | copybook field name |
| offset | 27 | 3 | count | 9(3) | zero-based offset |
| length | 31 | 3 | count | 9(3) | length in bytes |
| type | 35 | 12 | code | X(12) | alnum / zoned / zoned_signed / packed |
| scale | 48 | 1 | count | 9 | implied decimal places |
| date_window | 50 | 10 | code | X(10) | `YYMMDD/50` or `-` |
| pic | 61 | 20 | text | X(20) | PIC clause (documentation only) |

### LAYOUT POL

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| policy | 5 | 16 | code | X(16) | policy name |
| value | 22 | 24 | code | X(24) | semantics id |

### LAYOUT DIA

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| record | 5 | 8 | code | X(8) | ACCTMSTR or TRANS |
| records_label | 14 | 12 | literal | `RECORDS-READ` | label |
| records_read | 27 | 7 | count | 9(7) | records_read |
| tail_label | 35 | 18 | literal | `SKIPPED-TAIL-BYTES` | label |
| skipped_tail_bytes | 54 | 2 | count | 9(2) | skipped_tail_bytes |
| dup_label | 57 | 14 | literal | `DUPLICATE-KEYS` | label |
| duplicate_keys | 72 | 5 | count | 9(5) | duplicate_keys |

## POST (not parsed; excluded from parity/printspec.json)

POST copies `ACCTMSTR.DAT` of the selected view into a fresh OS temp directory, applies the amount to the first
record with that ACCT-ID in the copy (`D` adds, `C` subtracts), prints the temp path on stderr and one `PST`
line after `HDR`; no `TRL`/`END`. The fixture files are never opened for writing. The parity harness refuses
POST structurally; it is never run by tests against fixtures.

| Name | Start | Width | Kind | Picture | Meaning |
|---|---|---|---|---|---|
| acct_id | 5 | 10 | code | 9(10) | ACCT-ID |
| old_balance | 16 | 15 | money | ZZZ,ZZZ,ZZ9.99- | balance before, in the copy |
| new_balance | 32 | 15 | money | ZZZ,ZZZ,ZZ9.99- | balance after, in the copy |
| message | 48 | 9 | literal | `TEMP-COPY` | marker |
