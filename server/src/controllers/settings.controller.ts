import type { Request, Response } from "express";
import { env } from "../config/env.ts";
import { DecryptError, decrypt, encrypt } from "../lib/crypto.ts";
import { HttpError } from "../lib/httpError.ts";
import { hashPassword, verifyPassword } from "../lib/password.ts";
import { prisma } from "../lib/prisma.ts";
import { createGenerate, PROVIDERS, providerOf, type ProviderName } from "../review/llm/providers.ts";
import {
  LlmConnectionError,
  listLlmModels,
  normalizeBaseUrl,
  testLlmModel,
  verifyLlmConnection,
  type LlmConnectionStatus,
} from "../services/llmConnection.ts";
import {
  apiKeyParamsSchema,
  changePasswordSchema,
  deleteAccountSchema,
  reorderApiKeysSchema,
  saveApiKeySchema,
  testModelSchema,
  updateProfileSchema,
} from "../schemas/settings.schema.ts";
import { assertAnotherAdminRemains } from "../services/admins.ts";
import { clearCapabilities, endpointKey, listCapabilities, recordCapabilities } from "../services/llmCapabilities.ts";
import { probeModel } from "../services/llmProbe.ts";
import { auditedGenerate, recordSpent } from "../services/llmAudit.ts";
import { checkModel, connectionTarget, policyFor, targetOf, type LlmTarget } from "../services/privacyPolicy.ts";
import { assertEmailAvailable, emailTaken, isUniqueViolation } from "../services/users.ts";
import { releaseWorkspaces } from "../services/workspaces.ts";
import { clearAuthCookie, publicUser, setAuthCookie } from "./auth.controller.ts";

const SERVER_KEYS: Record<ProviderName, boolean> = {
  anthropic: Boolean(env.ANTHROPIC_API_KEY),
  openai: Boolean(env.OPENAI_API_KEY),
  google: Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY),
  ollama: false,
};

async function requirePassword(userId: string, password: string, field: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new HttpError(401, "Not authenticated");
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new HttpError(400, "Validation failed", { [field]: ["Password is incorrect"] });
  }
  return user;
}

// Only the last four characters ever leave the server, so the user can tell keys apart.
// A key written under another ENCRYPTION_KEY is still listed, flagged, so it
// can be replaced or removed rather than failing the whole list.
function publicKey(
  provider: ProviderName,
  stored?: { encryptedKey: string | null; baseUrl: string | null; updatedAt: Date },
  blocked = false,
) {
  let last4: string | null = null;
  let undecryptable = false;
  if (stored?.encryptedKey) {
    try {
      last4 = decrypt(stored.encryptedKey).slice(-4);
    } catch (error) {
      if (!(error instanceof DecryptError)) throw error;
      undecryptable = true;
    }
  }
  return {
    provider,
    stored: Boolean(stored),
    last4,
    undecryptable,
    baseUrl: stored?.baseUrl ?? null,
    updatedAt: stored?.updatedAt ?? null,
    serverDefault: SERVER_KEYS[provider],
    blocked,
  };
}

export async function updateProfile(req: Request, res: Response) {
  const data = updateProfileSchema.parse(req.body);

  if (data.email) {
    await assertEmailAvailable(prisma, data.email, req.userId!);
  }

  try {
    const user = await prisma.user.update({ where: { id: req.userId }, data, select: publicUser });
    res.json({ user });
  } catch (error) {
    // Another account claimed the email between the check and the update.
    if (isUniqueViolation(error)) {
      throw emailTaken();
    }
    throw error;
  }
}

export async function changePassword(req: Request, res: Response) {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  await requirePassword(req.userId!, currentPassword, "currentPassword");
  // Bumping the session version signs out every other session; this one gets a
  // fresh cookie on the new version so it stays signed in.
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { passwordHash: await hashPassword(newPassword), sessionVersion: { increment: 1 } },
    select: { id: true, sessionVersion: true },
  });
  setAuthCookie(res, user);
  res.status(204).end();
}

// A conflict rather than a 500: the row exists, but only re-entering it helps.
function storedApiKey(credential: { encryptedKey: string | null }): string | undefined {
  if (!credential.encryptedKey) return undefined;
  try {
    return decrypt(credential.encryptedKey);
  } catch (error) {
    if (error instanceof DecryptError) {
      throw new HttpError(409, "The stored key can't be decrypted; re-enter it");
    }
    throw error;
  }
}

// The privacy policy, checked before any request leaves for the connection's
// host: saving, listing and testing all reach it.
async function policyRefusal(workspaceId: string, target: LlmTarget) {
  return checkModel(await policyFor(workspaceId), target);
}

async function assertAllowed(workspaceId: string, target: LlmTarget, field: "baseUrl" | "model") {
  const violation = await policyRefusal(workspaceId, target);
  if (violation) throw new HttpError(400, "Validation failed", { [field]: [violation.message] });
}

// The saved order first; providers it does not name (none saved yet, or one
// added since) follow in their default order, and names no longer supported
// are skipped, so a changed provider list never hides a card.
function orderProviders(saved: string[]): ProviderName[] {
  const rank = (provider: ProviderName) => {
    const index = saved.indexOf(provider);
    return index === -1 ? saved.length + PROVIDERS.indexOf(provider) : index;
  };
  return [...PROVIDERS].sort((a, b) => rank(a) - rank(b));
}

export async function listApiKeys(req: Request, res: Response) {
  const [stored, workspace] = await Promise.all([
    prisma.llmCredential.findMany({ where: { workspaceId: req.workspaceId } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: req.workspaceId }, select: { llmProviderOrder: true } }),
  ]);
  const byProvider = new Map(stored.map((credential) => [credential.provider, credential]));
  // The policy refuses a provider or host whichever key would be used, so a
  // server-wide key is checked too: it has no status request to report it.
  const policy = await policyFor(req.workspaceId!);
  const keys = await Promise.all(
    orderProviders(workspace.llmProviderOrder).map(async (provider) => {
      const credential = byProvider.get(provider);
      const violation = await checkModel(policy, connectionTarget(provider, credential?.baseUrl));
      return publicKey(provider, credential, Boolean(violation));
    }),
  );
  res.json({ keys });
}

// One list on the workspace row, so a single write needs none of the row
// locking the forge reorders take.
export async function reorderApiKeys(req: Request, res: Response) {
  const { providers } = reorderApiKeysSchema.parse(req.body);
  await prisma.workspace.update({ where: { id: req.workspaceId }, data: { llmProviderOrder: providers } });
  res.status(204).end();
}

// The stored secret stays server-side while the provider confirms whether it
// still accepts the credential. Provider outages are distinct from rejection.
export async function apiKeyStatus(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const credential = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId: req.workspaceId!, provider } },
  });
  if (!credential) {
    throw new HttpError(404, "No key stored for this provider");
  }

  // A connection the policy now refuses is not called to find out more.
  const violation = await policyRefusal(req.workspaceId!, connectionTarget(provider, credential.baseUrl));
  if (violation) {
    res.json({ status: "blocked", message: violation.message });
    return;
  }
  const apiKey = storedApiKey(credential);
  let status: LlmConnectionStatus;
  try {
    await verifyLlmConnection(provider, apiKey, credential.baseUrl ?? undefined);
    status = "active";
  } catch (error) {
    status = error instanceof LlmConnectionError && error.connectionStatus === "revoked" ? "revoked" : "unreachable";
  }
  res.json({ status });
}

// Feeds the model picker; a host that rejects the key or is down answers with
// the same 400 as saving, and the picker falls back to free text.
export async function apiKeyModels(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const credential = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId: req.workspaceId!, provider } },
  });
  if (!credential) {
    throw new HttpError(404, "No key stored for this provider");
  }

  await assertAllowed(req.workspaceId!, connectionTarget(provider, credential.baseUrl), "baseUrl");
  const models = await listLlmModels(provider, storedApiKey(credential), credential.baseUrl ?? undefined);
  res.json({ models });
}

// Runs one minimal generation with the stored credential; the outcome, failed
// or not, is the answer, so provider errors come back as a 200 result.
export async function testApiKeyModel(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const { model } = testModelSchema.parse(req.body);
  const credential = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId: req.workspaceId!, provider } },
  });
  if (!credential) {
    throw new HttpError(404, "No key stored for this provider");
  }

  let modelProvider: ProviderName;
  try {
    modelProvider = providerOf(model);
  } catch {
    throw new HttpError(400, "Validation failed", { model: [`Use provider/model, e.g. ${provider}/<model id>`] });
  }
  // Same rule the worker applies: an official API only runs its own models.
  if (!credential.baseUrl && modelProvider !== provider) {
    throw new HttpError(400, "Validation failed", { model: [`This connection can only run ${provider}/... models`] });
  }

  const apiKey = storedApiKey(credential);
  const baseUrl = credential.baseUrl ?? undefined;
  const workspaceId = req.workspaceId!;
  const endpoint = baseUrl ? { baseUrl, apiKey } : undefined;
  const target = targetOf(endpoint, { [provider]: baseUrl })(model);
  await assertAllowed(workspaceId, target, "model");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
  const audit = { workspaceId, workspaceName: workspace.name, userId: req.userId };
  const result = await testLlmModel(provider, model, { apiKey, baseUrl }, (keys, ep) =>
    auditedGenerate(createGenerate(keys, ep), () => target, audit),
  );
  if (!result.ok) {
    res.json({ result });
    return;
  }
  // A model that answers is probed for what reviews may ask of it, and the
  // answer kept for them. A probe that fails costs the test nothing.
  const probe = await probeModel(model, apiKey ? { [provider]: apiKey } : {}, endpoint).catch(() => undefined);
  if (!probe) {
    res.json({ result });
    return;
  }
  await recordSpent(audit, "probe", target, probe.spent);
  await recordCapabilities(workspaceId, () => ({ provider: modelProvider, endpoint: endpointKey(baseUrl) }), [
    { model, capabilities: probe.capabilities, source: "probe", detail: probe.detail },
  ]);
  res.json({
    result: {
      ...result,
      capabilities: {
        thinking: probe.capabilities.thinking ?? null,
        tools: probe.capabilities.tools ?? null,
        detail: probe.detail,
      },
    },
  });
}

// What probes and reviews found this connection's models support, including
// for a provider keyed only from the server environment.
export async function apiKeyCapabilities(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const credential = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId: req.workspaceId!, provider } },
    select: { baseUrl: true },
  });
  res.json({ capabilities: await listCapabilities(req.workspaceId!, provider, credential?.baseUrl) });
}

export async function saveApiKey(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const input = saveApiKeySchema.parse(req.body);
  const apiKey = input.apiKey || undefined;
  if (provider !== "ollama" && (!apiKey || apiKey.length < 8)) {
    throw new HttpError(400, "Validation failed", { apiKey: ["That does not look like an API key"] });
  }
  if (provider === "ollama" && !input.baseUrl) {
    throw new HttpError(400, "Validation failed", { baseUrl: ["Ollama requires an API base URL"] });
  }

  const baseUrl = input.baseUrl ? normalizeBaseUrl(input.baseUrl) : undefined;
  const workspaceId = req.workspaceId!;
  await assertAllowed(workspaceId, connectionTarget(provider, baseUrl), "baseUrl");
  await verifyLlmConnection(provider, apiKey, baseUrl);
  const encryptedKey = apiKey ? encrypt(apiKey) : null;
  const previous = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId, provider } },
    select: { baseUrl: true },
  });
  const credential = await prisma.llmCredential.upsert({
    where: { workspaceId_provider: { workspaceId, provider } },
    create: { workspaceId, provider, encryptedKey, baseUrl },
    update: { encryptedKey, baseUrl: baseUrl ?? null },
  });
  await clearCapabilities(workspaceId, provider, previous?.baseUrl);
  if (previous?.baseUrl !== credential.baseUrl) await clearCapabilities(workspaceId, provider, credential.baseUrl);
  res.json({ key: publicKey(provider, credential) });
}

export async function deleteApiKey(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const credential = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId: req.workspaceId!, provider } },
    select: { baseUrl: true },
  });
  const { count } = await prisma.llmCredential.deleteMany({ where: { workspaceId: req.workspaceId, provider } });
  if (count === 0) {
    throw new HttpError(404, "No key stored for this provider");
  }
  await clearCapabilities(req.workspaceId!, provider, credential?.baseUrl);
  res.status(204).end();
}

// The personal workspace (connections, repositories, reviews, keys) cascades
// from the user row. The last admin can only leave once nobody else is left to
// administer, and team workspaces they own need another owner first.
export async function deleteAccount(req: Request, res: Response) {
  const { password } = deleteAccountSchema.parse(req.body);
  const user = await requirePassword(req.userId!, password, "password");
  await prisma.$transaction(async (tx) => {
    if (user.role === "admin" && (await tx.user.count()) > 1) {
      await assertAnotherAdminRemains(tx, user.id);
    }
    await releaseWorkspaces(tx, user.id, { promoteSuccessor: false });
    await tx.user.delete({ where: { id: user.id } });
  });
  clearAuthCookie(res);
  res.status(204).end();
}
