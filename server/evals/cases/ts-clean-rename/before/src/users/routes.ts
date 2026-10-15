import { Router } from "express";
import { prisma } from "../prisma.ts";
import { fmtName } from "./format.ts";

export const users = Router();

users.get("/:id", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ message: "Not found" });
  res.json({ id: user.id, name: fmtName(user) });
});
