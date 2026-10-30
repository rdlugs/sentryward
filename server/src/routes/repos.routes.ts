import { Router } from "express";
import { deleteRepo, enableRepo, getRepoConfig, listAvailableRepos, listLastReviews, listRepoChanges, listRepos, reorderRepos, updateRepo } from "../controllers/repos.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const reposRouter = Router();

reposRouter.use(userLimiter, requireAuth, requireWorkspace);
reposRouter.get("/", listRepos);
reposRouter.get("/available", listAvailableRepos);
reposRouter.get("/last-reviews", listLastReviews);
reposRouter.post("/", requireWorkspaceRole("admin"), enableRepo);
// Before the /:id routes, which would otherwise take "order" as an id.
reposRouter.put("/order", requireWorkspaceRole("admin"), reorderRepos);
reposRouter.patch("/:id", requireWorkspaceRole("admin"), updateRepo);
reposRouter.delete("/:id", requireWorkspaceRole("admin"), deleteRepo);
reposRouter.get("/:id/config", getRepoConfig);
reposRouter.get("/:id/changes", listRepoChanges);
