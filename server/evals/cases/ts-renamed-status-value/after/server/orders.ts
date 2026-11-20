export type OrderStatus = "open" | "shipped" | "cancelled" | "refunded";

export interface Order {
  id: string;
  status: OrderStatus;
}

export function cancelOrder(order: Order): void {
  order.status = "cancelled";
}

export function refundOrder(order: Order): void {
  order.status = "refunded";
}
