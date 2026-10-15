import { randomBytes } from "node:crypto";
import { redis } from "../redis.ts";

export interface Session {
  userId: string;
  expiresAt: number;
}

export async function createSession(userId: string): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const session: Session = { userId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  await redis.set(`session:${id}`, JSON.stringify(session));
  return id;
}

export async function readSession(id: string): Promise<Session | null> {
  const raw = await redis.get(`session:${id}`);
  if (!raw) return null;
  const session = JSON.parse(raw) as Session;
  return session.expiresAt > Date.now() ? session : null;
}
