import { z } from "zod";

// Stored hosts are bare for https ("gitlab.acme.com") and keep the scheme only
// for plain http, matching how change URLs are parsed.
export function normalizeHost(input: string): string | null {
  const raw = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash || url.username) {
    return null;
  }
  return url.protocol === "http:" ? `http://${url.host}` : url.host;
}

export const gitlabConnectSchema = z.object({
  host: z
    .string()
    .trim()
    .default("gitlab.com")
    .transform((value, ctx) => {
      const host = normalizeHost(value || "gitlab.com");
      if (!host) {
        ctx.addIssue({ code: "custom", message: "Enter a host such as gitlab.com" });
        return z.NEVER;
      }
      return host;
    }),
  token: z.string().trim().min(1, "Token is required"),
});

// GitHub.com connects through the GitHub App; a token is for Enterprise Server.
export const githubConnectSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1, "Host is required")
    .transform((value, ctx) => {
      const host = normalizeHost(value);
      if (!host) {
        ctx.addIssue({ code: "custom", message: "Enter a host such as github.example.com" });
        return z.NEVER;
      }
      if (host === "github.com") {
        ctx.addIssue({ code: "custom", message: "Use the GitHub App to connect github.com" });
        return z.NEVER;
      }
      return host;
    }),
  token: z.string().trim().min(1, "Token is required"),
});

// Every connection in the workspace, in the order to show them.
export const reorderConnectionsSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "Each connection may appear only once"),
});

export const githubInstallSchema = z.object({
  // Absent means the personal workspace.
  workspace: z.string().optional(),
});

export const gitlabOAuthStartSchema = githubInstallSchema;

// GitLab sends error= instead of code= when the user cancels.
export const gitlabOAuthCallbackSchema = z.object({
  state: z.string().min(1),
  code: z.string().optional(),
  error: z.string().optional(),
});

export const githubCallbackSchema = z.object({
  installation_id: z.string().regex(/^\d+$/).optional(),
  setup_action: z.string().optional(),
  state: z.string().min(1),
  code: z.string().optional(),
});
