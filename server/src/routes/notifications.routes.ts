import { Router } from "express";
import {
  createNotification,
  deleteNotification,
  listDeliveries,
  listNotifications,
  testNotification,
  updateNotification,
} from "../controllers/notifications.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

// Members can see where reviews are reported; only admins change it or send
// test deliveries, which reach outside services.
export const notificationsRouter = Router();

notificationsRouter.use(userLimiter, requireAuth, requireWorkspace);
notificationsRouter.get("/", listNotifications);
notificationsRouter.get("/:id/deliveries", listDeliveries);
notificationsRouter.post("/", requireWorkspaceRole("admin"), createNotification);
notificationsRouter.patch("/:id", requireWorkspaceRole("admin"), updateNotification);
notificationsRouter.post("/:id/test", requireWorkspaceRole("admin"), testNotification);
notificationsRouter.delete("/:id", requireWorkspaceRole("admin"), deleteNotification);
