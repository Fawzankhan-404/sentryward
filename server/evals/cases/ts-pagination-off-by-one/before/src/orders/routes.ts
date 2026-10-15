import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { listOrders } from "./list.ts";

export const orders = Router();

orders.get("/", requireAuth, async (req, res) => {
  res.json(await listOrders(req.userId!));
});
