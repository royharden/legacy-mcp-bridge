// LEGACY01 field decoding: the oracle's own implementation of zoned overpunch, COMP-3, implied decimals,
// YYMMDD dates and text cleanup. Works byte-at-a-time on a Buffer; knows nothing about any other decoder.

const ZERO = 0x30;
const NINE = 0x39;

// Text field: low-values become spaces, other non-printables become '?', trailing padding trimmed.
export function decodeText(buf, off, len) {
  let out = "";
  for (let i = 0; i < len; i++) {
    const b = buf[off + i];
    if (b === 0x00) {
      out += " ";
    } else if (b < 0x20 || b > 0x7e) {
      out += "?";
    } else {
      out += String.fromCharCode(b);
    }
  }
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 0x20) {
    end--;
  }
  return out.slice(0, end);
}

// Raw key text (no trimming) - keys compare on all their bytes.
export function decodeKey(buf, off, len) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(buf[off + i]);
  }
  return out;
}

// Unsigned display numeric 9(n): BigInt or null when any byte is not a digit.
export function decodeZonedUnsigned(buf, off, len) {
  let v = 0n;
  for (let i = 0; i < len; i++) {
    const b = buf[off + i];
    if (b < ZERO || b > NINE) {
      return null;
    }
    v = v * 10n + BigInt(b - ZERO);
  }
  return v;
}

// Signed display numeric with trailing overpunch:
//   '{' +0, 'A'..'I' +1..+9, '}' -0, 'J'..'R' -1..-9; a plain digit in the last byte is positive.
export function decodeZonedSigned(buf, off, len) {
  let v = 0n;
  for (let i = 0; i < len - 1; i++) {
    const b = buf[off + i];
    if (b < ZERO || b > NINE) {
      return null;
    }
    v = v * 10n + BigInt(b - ZERO);
  }
  const last = buf[off + len - 1];
  let digit;
  let negative = false;
  if (last >= ZERO && last <= NINE) {
    digit = last - ZERO;
  } else if (last === 0x7b) {
    digit = 0;
  } else if (last >= 0x41 && last <= 0x49) {
    digit = last - 0x41 + 1;
  } else if (last === 0x7d) {
    digit = 0;
    negative = true;
  } else if (last >= 0x4a && last <= 0x52) {
    digit = last - 0x4a + 1;
    negative = true;
  } else {
    return null;
  }
  v = v * 10n + BigInt(digit);
  return negative ? -v : v;
}

// Packed decimal: two digit nibbles per byte, last low nibble is the sign (C/F positive, D negative).
export function decodePacked(buf, off, len) {
  let v = 0n;
  for (let i = 0; i < len; i++) {
    const b = buf[off + i];
    const hi = (b >> 4) & 0x0f;
    const lo = b & 0x0f;
    if (hi > 9) {
      return null;
    }
    v = v * 10n + BigInt(hi);
    if (i < len - 1) {
      if (lo > 9) {
        return null;
      }
      v = v * 10n + BigInt(lo);
    } else {
      if (lo === 0x0c || lo === 0x0f) {
        return v;
      }
      if (lo === 0x0d) {
        return -v;
      }
      return null;
    }
  }
  return null;
}

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  if (m === 2) {
    return isLeapYear(y) ? 29 : 28;
  }
  if (m === 4 || m === 6 || m === 9 || m === 11) {
    return 30;
  }
  return 31;
}

// YYMMDD with pivot 50 (00-49 => 20YY, 50-99 => 19YY). 000000 means "never".
// Returns { kind: "date", y, m, d, key } | { kind: "never" } | { kind: "invalid" }.
export function decodeYYMMDD(buf, off) {
  const raw = decodeZonedUnsigned(buf, off, 6);
  if (raw === null) {
    return { kind: "invalid" };
  }
  if (raw === 0n) {
    return { kind: "never" };
  }
  const n = Number(raw);
  const yy = Math.trunc(n / 10000);
  const m = Math.trunc(n / 100) % 100;
  const d = n % 100;
  const y = yy < 50 ? 2000 + yy : 1900 + yy;
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    return { kind: "invalid" };
  }
  return { kind: "date", y, m, d, key: y * 10000 + m * 100 + d };
}
