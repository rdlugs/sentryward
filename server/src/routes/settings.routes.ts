import express, { Router } from "express";
import { createToken, listTokens, revokeToken } from "../controllers/apiTokens.controller.ts";
import { deleteModelPrice, getModelPrices, saveModelPrice } from "../controllers/modelPrices.controller.ts";
import { AVATAR_MAX_BYTES, AVATAR_TYPES, removeAvatar, uploadAvatar } from "../controllers/avatar.controller.ts";
import {
  apiKeyCapabilities,
  apiKeyModels,
  apiKeyStatus,
  changePassword,
  deleteAccount,
  deleteApiKey,
  listApiKeys,
  reorderApiKeys,
  saveApiKey,
  testApiKeyModel,
  updateProfile,
} from "../controllers/settings.controller.ts";
import { authLimiter } from "../middleware/authLimiter.ts";
import { requireAuth, requireSession } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const settingsRouter = Router();

settingsRouter.use(userLimiter, requireAuth);
settingsRouter.patch("/profile", updateProfile);
settingsRouter.put("/password", authLimiter, changePassword);
// The image is the raw request body; the app-wide parser only reads JSON.
settingsRouter.put("/avatar", express.raw({ type: [...AVATAR_TYPES], limit: AVATAR_MAX_BYTES }), uploadAvatar);
settingsRouter.delete("/avatar", removeAvatar);
// LLM keys belong to the workspace; profile, password and account to the user.
settingsRouter.use("/api-keys", requireWorkspace);
settingsRouter.get("/api-keys", listApiKeys);
settingsRouter.get("/api-keys/:provider/status", apiKeyStatus);
settingsRouter.get("/api-keys/:provider/models", apiKeyModels);
settingsRouter.get("/api-keys/:provider/capabilities", apiKeyCapabilities);
settingsRouter.post("/api-keys/:provider/test", testApiKeyModel);
// Before /:provider, which would otherwise take "order" for a provider name.
settingsRouter.put("/api-keys/order", requireWorkspaceRole("admin"), reorderApiKeys);
settingsRouter.put("/api-keys/:provider", requireWorkspaceRole("admin"), saveApiKey);
settingsRouter.delete("/api-keys/:provider", requireWorkspaceRole("admin"), deleteApiKey);
// Prices belong to the workspace too: what its reviews' costs are worked out at.
settingsRouter.use("/model-prices", requireWorkspace);
settingsRouter.get("/model-prices", getModelPrices);
settingsRouter.put("/model-prices", requireWorkspaceRole("admin"), saveModelPrice);
settingsRouter.delete("/model-prices/:id", requireWorkspaceRole("admin"), deleteModelPrice);
settingsRouter.delete("/account", authLimiter, deleteAccount);
// Cookie only, so a leaked token can neither mint more nor hide itself.
settingsRouter.use("/tokens", requireSession);
settingsRouter.get("/tokens", listTokens);
settingsRouter.post("/tokens", createToken);
settingsRouter.delete("/tokens/:id", revokeToken);
