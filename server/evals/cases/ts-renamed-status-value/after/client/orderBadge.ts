// Statuses arrive as JSON strings from GET /api/orders.
export function badgeFor(status: string): string {
  if (status === "canceled") return "Cancelled";
  if (status === "shipped") return "Shipped";
  if (status === "refunded") return "Refunded";
  return "Open";
}
