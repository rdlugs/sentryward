import { z } from "zod";
import { dashboardOverrideSchema } from "../review/config/schema.ts";

// Without a connectionId, lists the added repositories of every connection.
export const listReposQuerySchema = z.object({
  connectionId: z.uuid().optional(),
});

export const availableReposQuerySchema = z.object({
  connectionId: z.uuid(),
});

// Every added repository in the workspace, in the order to show them.
export const reorderReposSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "Each repository may appear only once"),
});

export const enableRepoSchema = z.object({
  connectionId: z.uuid(),
  externalId: z.string().min(1),
});

// `settings` replaces the saved overrides as a whole; an empty object resets
// the repository to the global config, its profile and the defaults.
export const updateRepoSchema = z
  .object({
    enabled: z.boolean().optional(),
    settings: dashboardOverrideSchema.optional(),
    followGlobal: z.boolean().optional(),
  })
  .refine((body) => body.enabled !== undefined || body.settings !== undefined || body.followGlobal !== undefined, {
    message: "Provide enabled, settings or followGlobal",
    path: ["enabled"],
  });

export const repoIdParamSchema = z.object({ id: z.uuid() });
