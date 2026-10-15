import { Router } from "express";
import { findById } from "./repository.ts";

export const products = Router();

products.get("/:id", async (req, res) => {
  const product = await findById(Number(req.params.id));
  if (!product) return res.status(404).json({ message: "Not found" });
  res.json(product);
});
