import { z } from "zod";
import { pageSchema } from "./pagination.ts";

const NOTIFICATION_EVENTS = ["blocked", "failed", "completed"] as const;

const name = z.string().trim().min(1, "Name is required").max(100);
const events = z
  .array(z.enum(NOTIFICATION_EVENTS))
  .min(1, "Choose at least one event")
  .transform((list) => [...new Set(list)]);
const url = z.url({ protocol: /^https?$/, error: "Enter an http or https URL" }).max(2000);
const recipientIds = z
  .array(z.uuid())
  .min(1, "Choose at least one member")
  .max(100)
  .transform((list) => [...new Set(list)]);

export const createNotificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("webhook"), name, events, url }),
  z.object({ kind: z.literal("slack"), name, events, url }),
  z.object({ kind: z.literal("email"), name, events, recipientIds }),
]);

// The URL is not editable: replacing it is removing the target and adding it
// again, which for a webhook also issues a new secret.
export const updateNotificationSchema = z
  .object({
    name: name.optional(),
    events: events.optional(),
    recipientIds: recipientIds.optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Nothing to update",
    path: ["name"],
  });

export const notificationParamsSchema = z.object({ id: z.uuid() });

export const deliveriesQuerySchema = z.object({
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
