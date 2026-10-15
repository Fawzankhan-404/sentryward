import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { prisma } from "../prisma.ts";

export const projects = Router();

async function loadOwned(userId: string, id: string) {
  return prisma.project.findFirst({ where: { id, ownerId: userId } });
}

projects.get("/", requireAuth, async (req, res) => {
  res.json(await prisma.project.findMany({ where: { ownerId: req.userId } }));
});

projects.get("/:id", requireAuth, async (req, res) => {
  const project = await loadOwned(req.userId!, req.params.id);
  if (!project) return res.status(404).json({ message: "Not found" });
  res.json(project);
});

projects.patch("/:id", requireAuth, async (req, res) => {
  const project = await loadOwned(req.userId!, req.params.id);
  if (!project) return res.status(404).json({ message: "Not found" });
  const name = String(req.body.name ?? project.name);
  res.json(await prisma.project.update({ where: { id: project.id }, data: { name } }));
});
