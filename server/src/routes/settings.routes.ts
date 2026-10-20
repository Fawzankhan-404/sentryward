import express, { Router } from "express";
import { AVATAR_MAX_BYTES, AVATAR_TYPES, removeAvatar, uploadAvatar } from "../controllers/avatar.controller.ts";
import {
  apiKeyModels,
  apiKeyStatus,
  changePassword,
  deleteAccount,
  deleteApiKey,
  listApiKeys,
  saveApiKey,
  testApiKeyModel,
  updateProfile,
} from "../controllers/settings.controller.ts";
import { authLimiter } from "../middleware/authLimiter.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
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
settingsRouter.post("/api-keys/:provider/test", testApiKeyModel);
settingsRouter.put("/api-keys/:provider", requireWorkspaceRole("admin"), saveApiKey);
settingsRouter.delete("/api-keys/:provider", requireWorkspaceRole("admin"), deleteApiKey);
settingsRouter.delete("/account", authLimiter, deleteAccount);
