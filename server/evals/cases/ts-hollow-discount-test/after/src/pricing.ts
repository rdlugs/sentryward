export function applyDiscount(total: number, percent: number): number {
  const capped = Math.min(Math.max(percent, 0), 100);
  return total - total * (capped / 100);
}
