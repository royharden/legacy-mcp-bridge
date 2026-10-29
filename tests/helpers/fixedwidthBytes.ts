// tests/helpers/fixedwidthBytes.ts — builds literal fixed-width byte buffers inside tests (ASCII text + explicit hex bytes),
// so unit tests never depend on generated fixtures (PLAN.md §2 #16). Field defaults follow fixtures/plants.json
// acctmstr.defaults; every value passed in is a hand-written literal.

export function ascii(s: string): Buffer {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) throw new Error(`non-ASCII test literal: ${s}`);
  }
  return Buffer.from(s, "latin1");
}

export function hex(h: string): Buffer {
  if (!/^(?:[0-9A-Fa-f]{2})*$/.test(h)) throw new Error(`bad hex literal: ${h}`);
  return Buffer.from(h, "hex");
}

/** Text right-padded with spaces to exactly `width` bytes (throws if too long). */
export function padText(s: string, width: number): Buffer {
  if (s.length > width) throw new Error(`"${s}" is longer than ${width}`);
  return ascii(s.padEnd(width, " "));
}

/** Exact-width ASCII (throws unless the literal already has the width). */
export function exact(s: string, width: number): Buffer {
  if (s.length !== width) throw new Error(`"${s}" must be exactly ${width} bytes`);
  return ascii(s);
}

export type AcctFields = {
  id: string;
  name: string;
  status?: string;
  open?: string;
  balance: string;
  creditHex?: string;
  rate?: string;
  taxId: string;
  memo?: string;
  fillerHex?: string;
};

/** One 100-byte ACCTMSTR record (LEGACY-BEHAVIOUR §3). */
export function acctRecord(f: AcctFields): Buffer {
  const out = Buffer.concat([
    exact(f.id, 10),
    padText(f.name, 25),
    exact(f.status ?? "A", 1),
    exact(f.open ?? "980315", 6),
    exact(f.balance, 11),
    hex(f.creditHex ?? "000100000C"),
    exact(f.rate ?? "0035", 4),
    padText(f.taxId, 9),
    padText(f.memo ?? "", 25),
    hex(f.fillerHex ?? "00000000"),
  ]);
  if (out.length !== 100) throw new Error(`ACCTMSTR record is ${out.length} bytes`);
  return out;
}

export type TranFields = {
  tranId: string;
  acctId: string;
  date: string;
  type: string;
  amount: string;
  status: string;
  desc: string;
};

/** One 80-byte TRANS record (LEGACY-BEHAVIOUR §4). */
export function tranRecord(f: TranFields): Buffer {
  const out = Buffer.concat([
    exact(f.tranId, 10),
    exact(f.acctId, 10),
    exact(f.date, 6),
    exact(f.type, 1),
    exact(f.amount, 9),
    exact(f.status, 1),
    padText(f.desc, 30),
    padText("", 13),
  ]);
  if (out.length !== 80) throw new Error(`TRANS record is ${out.length} bytes`);
  return out;
}
