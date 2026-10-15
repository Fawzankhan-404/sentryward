import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { listUploads } from "./store.ts";

export const files = Router();

files.use(requireAuth);

files.get("/", async (req, res) => {
  res.json(await listUploads(req.userId!));
});
