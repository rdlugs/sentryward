import { Router } from "express";
import {
  cancelReview,
  createReview,
  getReview,
  getReviewAttention,
  getReviewMarkdown,
  getReviewStats,
  listReviews,
  markReviewsViewed,
  rerunReview,
} from "../controllers/reviews.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const reviewsRouter = Router();

reviewsRouter.use(userLimiter, requireAuth, requireWorkspace);
reviewsRouter.get("/", listReviews);
reviewsRouter.post("/", createReview);
// Before "/:id", which would reject these as malformed ids.
reviewsRouter.get("/stats", getReviewStats);
reviewsRouter.get("/attention", getReviewAttention);
reviewsRouter.post("/viewed", markReviewsViewed);
reviewsRouter.get("/:id", getReview);
reviewsRouter.get("/:id/markdown", getReviewMarkdown);
reviewsRouter.post("/:id/rerun", rerunReview);
reviewsRouter.post("/:id/cancel", cancelReview);
