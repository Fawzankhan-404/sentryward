import type { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma.ts";

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(401).json({ message: "Sign in" });
  if (user.role !== "admin") return res.status(403).json({ message: "Admins only" });
  next();
}
