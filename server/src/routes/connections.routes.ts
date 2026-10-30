import { Router } from "express";
import {
  connectionStatus,
  connectWithToken,
  deleteConnection,
  getConnection,
  githubCallback,
  githubInstall,
  gitlabOAuthCallback,
  gitlabOAuthStart,
  listConnections,
  reorderConnections,
} from "../controllers/connections.controller.ts";
import { requireAuth, requireSession } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const connectionsRouter = Router();

connectionsRouter.use(userLimiter, requireAuth);
// Browser navigations without the workspace header; they check the workspace
// themselves. Cookie only: though GET, they add connections, and a leaked API
// token could otherwise attach its holder's own installation or account.
connectionsRouter.get("/github/install", requireSession, githubInstall);
connectionsRouter.get("/github/callback", requireSession, githubCallback);
connectionsRouter.get("/gitlab/oauth/start", requireSession, gitlabOAuthStart);
connectionsRouter.get("/gitlab/oauth/callback", requireSession, gitlabOAuthCallback);
connectionsRouter.use(requireWorkspace);
connectionsRouter.get("/", listConnections);
// Before the /:id routes, which would otherwise take "order" as an id.
connectionsRouter.put("/order", requireWorkspaceRole("admin"), reorderConnections);
connectionsRouter.get("/:id/status", connectionStatus);
connectionsRouter.get("/:id", getConnection);
connectionsRouter.post("/:provider", requireWorkspaceRole("admin"), connectWithToken);
connectionsRouter.delete("/:id", requireWorkspaceRole("admin"), deleteConnection);
