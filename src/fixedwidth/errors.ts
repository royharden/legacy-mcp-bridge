// src/fixedwidth/errors.ts — named errors of the fixed-width layer (copybook grammar, layout checks, field decoding).
// They are internal: the bridge maps them to a ToolError before anything reaches an MCP client.

export const FIXED_WIDTH_ERROR_CODES = [
  "UnsupportedClause",
  "LayoutMismatch",
  "BadDigit",
  "BadSign",
  "BadPacked",
  "BadDate",
  "Overflow",
] as const;

export type FixedWidthErrorCode = (typeof FIXED_WIDTH_ERROR_CODES)[number];

export class FixedWidthError extends Error {
  readonly code: FixedWidthErrorCode;

  constructor(code: FixedWidthErrorCode, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

/** A copybook construct outside the supported subset (REDEFINES, OCCURS, COPY, VALUE, COMP, other levels, bad syntax). */
export class UnsupportedClause extends FixedWidthError {
  /** The offending clause or construct, e.g. "REDEFINES", "OCCURS", "COPY", "LEVEL 10", "SYNTAX". */
  readonly clause: string;

  constructor(clause: string, message: string) {
    super("UnsupportedClause", message);
    this.clause = clause;
  }
}

export class LayoutMismatch extends FixedWidthError {
  constructor(message: string) {
    super("LayoutMismatch", message);
  }
}

export class BadDigit extends FixedWidthError {
  constructor(message: string) {
    super("BadDigit", message);
  }
}

export class BadSign extends FixedWidthError {
  constructor(message: string) {
    super("BadSign", message);
  }
}

export class BadPacked extends FixedWidthError {
  constructor(message: string) {
    super("BadPacked", message);
  }
}

export class BadDate extends FixedWidthError {
  constructor(message: string) {
    super("BadDate", message);
  }
}

export class Overflow extends FixedWidthError {
  constructor(message: string) {
    super("Overflow", message);
  }
}
