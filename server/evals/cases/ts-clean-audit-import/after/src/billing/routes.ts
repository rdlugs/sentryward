import { Router } from "express";
import { refundInvoice } from "./refunds";

export const billingRouter = Router();

billingRouter.post("/invoices/:id/refunds", async (req, res) => {
  await refundInvoice(req.params.id, Number(req.body.amountCents));
  res.status(204).end();
});
