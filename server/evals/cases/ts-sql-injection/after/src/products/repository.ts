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

export async function search(term: string, limit = 20): Promise<Product[]> {
  const sql = `SELECT id, name, price_cents FROM ${TABLE} WHERE name ILIKE '%${term}%' ORDER BY name LIMIT ${limit}`;
  const { rows } = await pool.query(sql);
  return rows;
}
