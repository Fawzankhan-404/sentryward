import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.ts";
import { adminRouter } from "./routes/admin.routes.ts";
import { authRouter } from "./routes/auth.routes.ts";
import { configRouter } from "./routes/config.routes.ts";
import { connectionsRouter } from "./routes/connections.routes.ts";
import { findingsRouter } from "./routes/findings.routes.ts";
import { reposRouter } from "./routes/repos.routes.ts";
import { reviewsRouter } from "./routes/reviews.routes.ts";
import { settingsRouter } from "./routes/settings.routes.ts";
import { usersRouter } from "./routes/users.routes.ts";
import { webhooksRouter } from "./routes/webhooks.routes.ts";
import { workspacesRouter } from "./routes/workspaces.routes.ts";
import { clientApp } from "./middleware/clientApp.ts";
import { errorHandler } from "./middleware/errorHandler.ts";
import { WORKSPACE_HEADER } from "./services/workspaces.ts";

export const app = express();

if (env.TRUST_PROXY !== undefined) {
  app.set("trust proxy", env.TRUST_PROXY);
}

app.use(helmet());
app.use(
  cors({
    origin: env.CLIENT_ORIGIN,
    credentials: true,
    allowedHeaders: ["Content-Type", WORKSPACE_HEADER],
  }),
);
// Before the JSON parser: webhook signatures need the raw body.
app.use("/api/webhooks", webhooksRouter);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/connections", connectionsRouter);
app.use("/api/repos", reposRouter);
app.use("/api/config", configRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/findings", findingsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/users", usersRouter);
app.use("/api/workspaces", workspacesRouter);

if (env.STATIC_DIR) {
  app.use(clientApp(env.STATIC_DIR));
}

app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use(errorHandler);
