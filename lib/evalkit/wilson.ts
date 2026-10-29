// Wilson 95% binomial interval, without a normal approximation at the endpoints. No estimate exists for zero trials.
export function wilson(successes: number, total: number): { low: number; high: number } | null {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total < 0 || successes > total) throw new Error("invalid Wilson counts");
  if (total === 0) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const middle = (p + z2 / (2 * total)) / denominator;
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return { low: Math.max(0, middle - half), high: Math.min(1, middle + half) };
}
