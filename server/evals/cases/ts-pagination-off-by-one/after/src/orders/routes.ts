import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import { listOrders } from "./list.ts";

export const orders = Router();

const query = z.object({ page: z.coerce.number().int().min(1).default(1) });

orders.get("/", requireAuth, async (req, res) => {
  const { page } = query.parse(req.query);
  res.json(await listOrders(req.userId!, page));
});
