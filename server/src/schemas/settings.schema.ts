import { z } from "zod";
import { PROVIDERS } from "../review/llm/providers.ts";

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100).optional(),
    email: z.string().trim().toLowerCase().email("Invalid email address").optional(),
  })
  .refine((data) => data.name !== undefined || data.email !== undefined, {
    message: "Nothing to update",
    path: ["name"],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "Password must be at least 8 characters").max(128),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const apiKeyParamsSchema = z.object({ provider: z.enum(PROVIDERS) });

// Every provider, in the order to show them. The whole list, so none is left
// to land somewhere nobody chose.
export const reorderApiKeysSchema = z.object({
  providers: z
    .array(z.enum(PROVIDERS))
    .refine(
      (providers) => providers.length === PROVIDERS.length && new Set(providers).size === providers.length,
      "List each provider exactly once",
    ),
});

export const saveApiKeySchema = z.object({
  apiKey: z.string().trim().max(500).optional(),
  baseUrl: z.url({ protocol: /^https?$/, error: "Enter an http or https URL" }).max(500).optional(),
});

export const testModelSchema = z.object({
  model: z.string().trim().min(1, "Choose a model").max(200),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

// Null for a token that never expires.
export const createApiTokenSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  expiresInDays: z.number().int().min(1).max(365).nullable(),
});

export const apiTokenParamsSchema = z.object({ id: z.uuid() });
