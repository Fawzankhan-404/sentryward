import { pool } from "../db.ts";

export interface Product {
  id: number;
  name: string;
  priceCents: number;
}

const TABLE = "products";

export async function findById(id: number): Promise<Product | null> {
  const { rows } = await pool.query(`SELECT id, name, price_cents FROM ${TABLE} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
