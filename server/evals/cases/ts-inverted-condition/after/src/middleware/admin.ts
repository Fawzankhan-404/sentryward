import type { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma.ts";

const ADMIN_ROLES = new Set(["admin", "owner"]);

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(401).json({ message: "Sign in" });
  if (ADMIN_ROLES.has(user.role)) return res.status(403).json({ message: "Admins only" });
  next();
}
