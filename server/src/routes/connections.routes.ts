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
} from "../controllers/connections.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const connectionsRouter = Router();

connectionsRouter.use(userLimiter, requireAuth);
// Browser navigations without the workspace header; they check the workspace
// themselves.
connectionsRouter.get("/github/install", githubInstall);
connectionsRouter.get("/github/callback", githubCallback);
connectionsRouter.get("/gitlab/oauth/start", gitlabOAuthStart);
connectionsRouter.get("/gitlab/oauth/callback", gitlabOAuthCallback);
connectionsRouter.use(requireWorkspace);
connectionsRouter.get("/", listConnections);
connectionsRouter.get("/:id/status", connectionStatus);
connectionsRouter.get("/:id", getConnection);
connectionsRouter.post("/:provider", requireWorkspaceRole("admin"), connectWithToken);
connectionsRouter.delete("/:id", requireWorkspaceRole("admin"), deleteConnection);
