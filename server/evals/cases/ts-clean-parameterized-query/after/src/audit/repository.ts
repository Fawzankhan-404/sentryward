import { pool } from "../db.ts";

export interface AuditEvent {
  id: number;
  actorId: string;
  action: string;
  createdAt: Date;
}

const COLUMNS = "id, actor_id, action, created_at";

export async function recentEvents(actorId: string): Promise<AuditEvent[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM audit_events WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [actorId],
  );
  return rows;
}

export async function searchEvents(actorId: string, action: string, limit: number): Promise<AuditEvent[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 200);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM audit_events WHERE actor_id = $1 AND action ILIKE $2 ORDER BY created_at DESC LIMIT $3`,
    [actorId, `%${action}%`, capped],
  );
  return rows;
}
