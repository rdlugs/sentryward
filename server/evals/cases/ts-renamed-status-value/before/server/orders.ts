export type OrderStatus = "open" | "shipped" | "canceled";

export interface Order {
  id: string;
  status: OrderStatus;
}

export function cancelOrder(order: Order): void {
  order.status = "canceled";
}
