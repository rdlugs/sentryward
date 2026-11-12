import { db } from "../db";
import { audit } from "../lib/audit";

export async function refundInvoice(invoiceId: string, amountCents: number) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("invalid refund amount");
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("invoice not found");
  if (amountCents > invoice.paidCents) throw new Error("refund exceeds amount paid");
  await db.refund.create({ data: { invoiceId, amountCents } });
  audit("invoice.refunded", { invoiceId, amountCents });
}
