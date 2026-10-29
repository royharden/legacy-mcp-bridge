// LEGACY01 edit pictures: money with thousands separators and trailing sign, zero-filled counts,
// ISO dates / NEVER / INVALID, 9.999 rates and the raw tax id. Money is BigInt minor units only.

function fill(ch, width) {
  return ch.repeat(width);
}

// 1234567n -> "12,345.67 " ; -123456n -> "1,234.56-". Right-aligned; '*' fill when it does not fit; '?' when null.
export function editMoney(minor, width) {
  if (minor === null || minor === undefined) {
    return fill("?", width);
  }
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString();
  const cents = (abs % 100n).toString().padStart(2, "0");
  let grouped = "";
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) {
      grouped += ",";
    }
    grouped += whole[i];
  }
  const s = grouped + "." + cents + (negative ? "-" : " ");
  if (s.length > width) {
    return fill("*", width);
  }
  return s.padStart(width, " ");
}

// Zero-filled unsigned count, 9(n) style.
export function editCount(n, width) {
  const s = String(n);
  if (n < 0 || s.length > width) {
    return fill("*", width);
  }
  return s.padStart(width, "0");
}

export function editDate(dt) {
  if (dt.kind === "never") {
    return "NEVER";
  }
  if (dt.kind === "invalid") {
    return "INVALID";
  }
  return String(dt.y).padStart(4, "0") + "-" + String(dt.m).padStart(2, "0") + "-" + String(dt.d).padStart(2, "0");
}

// Rate 9V999 in thousandths: 35n -> "0.035".
export function editRate(thousandths) {
  if (thousandths === null || thousandths === undefined) {
    return "?????";
  }
  const whole = (thousandths / 1000n).toString();
  const frac = (thousandths % 1000n).toString().padStart(3, "0");
  return whole + "." + frac;
}

// The legacy program prints the tax id as stored (all 9 characters, unmasked); a blank tax id prints blank.
// Masking is the bridge's job; parity checks bridge value == mask(oracle value).
export function editTaxId(raw) {
  let printable = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    printable += c === 0 ? " " : c < 0x20 || c > 0x7e ? "?" : raw[i];
  }
  if (printable.trim() === "") {
    return "";
  }
  return printable;
}

// Monthly interest: trunc(balance_minor * rate_thousandths / 12000), BigInt division truncates toward zero.
export function monthlyInterest(balanceMinor, rateThousandths) {
  if (balanceMinor === null || rateThousandths === null) {
    return null;
  }
  return (balanceMinor * rateThousandths) / 12000n;
}
