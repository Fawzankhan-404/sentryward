import { Router } from "express";
import { findById, search } from "./repository.ts";

export const products = Router();

products.get("/search", async (req, res) => {
  const term = String(req.query.q ?? "");
  res.json(await search(term));
});

products.get("/:id", async (req, res) => {
  const product = await findById(Number(req.params.id));
  if (!product) return res.status(404).json({ message: "Not found" });
  res.json(product);
});
