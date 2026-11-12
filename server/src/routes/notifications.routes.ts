import { Router } from "express";
import {
  createNotification,
  deleteNotification,
  getPersonalNotifications,
  listDeliveries,
  listNotifications,
  rotateNotificationSecret,
  testNotification,
  updateNotification,
  updateNotificationSettings,
  updatePersonalNotifications,
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
// Before /:id, which would take "settings" or "personal" for a target id.
notificationsRouter.patch("/settings", requireWorkspaceRole("admin"), updateNotificationSettings);
// Every member manages their own; no role needed.
notificationsRouter.get("/personal", getPersonalNotifications);
notificationsRouter.put("/personal", updatePersonalNotifications);
notificationsRouter.patch("/:id", requireWorkspaceRole("admin"), updateNotification);
notificationsRouter.post("/:id/test", requireWorkspaceRole("admin"), testNotification);
notificationsRouter.post("/:id/rotate-secret", requireWorkspaceRole("admin"), rotateNotificationSecret);
notificationsRouter.delete("/:id", requireWorkspaceRole("admin"), deleteNotification);
