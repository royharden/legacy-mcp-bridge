// src/fixedwidth/layout.ts — the layout JSON contract (fixtures/layouts/*.json): types, a strict shape validator and a file
// loader. Layouts are read at runtime with fs (never imported as JSON modules: fixtures/ is outside the build rootDir).
import { readFileSync } from "node:fs";
import { LayoutMismatch } from "./errors.ts";

export const LAYOUT_FIELD_TYPES = ["alnum", "zoned", "packed", "date_yymmdd", "lowvalues"] as const;
export type LayoutFieldType = (typeof LAYOUT_FIELD_TYPES)[number];

export type DateWindow = { pivot: number; never: string | null };
export type CopybookPointer = { file: string; line: number; pic: string };

export type LayoutField = {
  name: string;
  /** Exposed JSON property name; null for FILLER. */
  property: string | null;
  offset: number;
  length: number;
  type: LayoutFieldType;
  /** Present for zoned and packed fields. */
  digits?: number;
  scale: number;
  signed: boolean;
  key?: boolean;
  exposed: boolean;
  untrustedText?: boolean;
  mask?: "last4";
  dateWindow?: DateWindow;
  meaning: string;
  quirk: string;
  copybook: CopybookPointer;
};

export type Layout = {
  version: number;
  record: string;
  file: string;
  copybook: string;
  recordLength: number;
  fields: LayoutField[];
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(where: string, what: string): never {
  throw new LayoutMismatch(`layout ${where}: ${what}`);
}

function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) fail(where, `"${k}" must be a non-empty string`);
  return v;
}

function int(o: Obj, k: string, where: string, min: number): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) fail(where, `"${k}" must be an integer >= ${min}`);
  return v;
}

function bool(o: Obj, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") fail(where, `"${k}" must be a boolean`);
  return v;
}

function optBool(o: Obj, k: string, where: string): boolean | undefined {
  return o[k] === undefined ? undefined : bool(o, k, where);
}

function loadField(raw: unknown, index: number): LayoutField {
  const where = `field[${index}]`;
  if (!isObj(raw)) fail(where, "must be an object");
  const o: Obj = raw;
  const name = str(o, "name", where);
  const propertyRaw = o["property"];
  const property: string | null =
    propertyRaw === null
      ? null
      : typeof propertyRaw === "string" && propertyRaw.length > 0
        ? propertyRaw
        : fail(where, `"property" must be a non-empty string or null`);
  const typeRaw = o["type"];
  const type = LAYOUT_FIELD_TYPES.find((t) => t === typeRaw);
  if (type === undefined) fail(where, `unknown "type" ${String(typeRaw)}`);

  const field: LayoutField = {
    name,
    property,
    offset: int(o, "offset", where, 0),
    length: int(o, "length", where, 1),
    type,
    scale: int(o, "scale", where, 0),
    signed: bool(o, "signed", where),
    exposed: bool(o, "exposed", where),
    meaning: str(o, "meaning", where),
    quirk: str(o, "quirk", where),
    copybook: (() => {
      const c = o["copybook"];
      if (!isObj(c)) fail(where, `"copybook" must be an object`);
      return { file: str(c, "file", where), line: int(c, "line", where, 1), pic: str(c, "pic", where) };
    })(),
  };

  if (o["digits"] !== undefined) field.digits = int(o, "digits", where, 1);
  const key = optBool(o, "key", where);
  if (key !== undefined) field.key = key;
  const untrusted = optBool(o, "untrustedText", where);
  if (untrusted !== undefined) field.untrustedText = untrusted;
  if (o["mask"] !== undefined) {
    if (o["mask"] !== "last4") fail(where, `"mask" must be "last4"`);
    field.mask = "last4";
  }
  if (o["dateWindow"] !== undefined) {
    const w = o["dateWindow"];
    if (!isObj(w)) fail(where, `"dateWindow" must be an object`);
    const pivot = int(w, "pivot", where, 0);
    if (pivot > 99) fail(where, `"dateWindow.pivot" must be 0..99`);
    const neverRaw = w["never"];
    const never: string | null =
      neverRaw === null
        ? null
        : typeof neverRaw === "string" && /^[0-9]{6}$/.test(neverRaw)
          ? neverRaw
          : fail(where, `"dateWindow.never" must be six digits or null`);
    field.dateWindow = { pivot, never };
  }

  // Per-type consistency.
  if (field.type === "zoned" || field.type === "packed") {
    if (field.digits === undefined) fail(where, `${field.type} field needs "digits"`);
    const expected = field.type === "zoned" ? field.digits : Math.floor(field.digits / 2) + 1;
    if (field.length !== expected) fail(where, `${field.type} length ${field.length} != ${expected} for ${field.digits} digits`);
    if (field.scale > field.digits) fail(where, `scale ${field.scale} exceeds digits ${field.digits}`);
  } else {
    if (field.signed) fail(where, `${field.type} field cannot be signed`);
    if (field.type === "date_yymmdd") {
      if (field.length !== 6) fail(where, "date_yymmdd length must be 6");
      if (field.dateWindow === undefined) fail(where, `date_yymmdd field needs "dateWindow"`);
    }
  }
  if (field.exposed && field.property === null) fail(where, "an exposed field needs a property name");
  if (field.type === "lowvalues" && field.exposed) fail(where, "lowvalues filler is never exposed");
  return field;
}

/** Validate an already-parsed layout JSON value: shape, per-type rules, contiguous offsets, sum of lengths = recordLength. */
export function loadLayout(json: unknown): Layout {
  if (!isObj(json)) fail("root", "must be an object");
  const record = str(json, "record", "root");
  const fieldsRaw = json["fields"];
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) fail(record, `"fields" must be a non-empty array`);
  const layout: Layout = {
    version: int(json, "version", record, 1),
    record,
    file: str(json, "file", record),
    copybook: str(json, "copybook", record),
    recordLength: int(json, "recordLength", record, 1),
    fields: fieldsRaw.map((f: unknown, i: number) => loadField(f, i)),
  };

  let next = 0;
  const seen = new Set<string>();
  for (const f of layout.fields) {
    if (f.offset !== next) fail(record, `field ${f.name} starts at ${f.offset}, expected ${next} (offsets must be contiguous)`);
    next = f.offset + f.length;
    if (f.property !== null) {
      if (seen.has(f.property)) fail(record, `duplicate property ${f.property}`);
      seen.add(f.property);
    }
  }
  if (next !== layout.recordLength) fail(record, `field lengths sum to ${next}, recordLength is ${layout.recordLength}`);
  return layout;
}

/** Read and validate a layout JSON file. */
export function loadLayoutFile(path: string): Layout {
  return loadLayout(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
