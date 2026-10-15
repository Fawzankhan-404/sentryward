import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { UPLOAD_ROOT, listUploads } from "./store.ts";

export const files = Router();

files.use(requireAuth);

files.get("/", async (req, res) => {
  res.json(await listUploads(req.userId!));
});

files.get("/download", (req, res) => {
  const name = String(req.query.name ?? "");
  const path = join(UPLOAD_ROOT, req.userId!, name);
  if (!existsSync(path)) return res.status(404).json({ message: "Not found" });
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`);
  createReadStream(path).pipe(res);
});
