import { pool } from "../db.ts";

export interface AuditEvent {
  id: number;
  actorId: string;
  action: string;
  createdAt: Date;
}

export async function recentEvents(actorId: string): Promise<AuditEvent[]> {
  const { rows } = await pool.query(
    "SELECT id, actor_id, action, created_at FROM audit_events WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 50",
    [actorId],
  );
  return rows;
}
