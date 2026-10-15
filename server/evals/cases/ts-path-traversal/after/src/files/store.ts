import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? "/var/lib/app/uploads";

export async function listUploads(userId: string): Promise<string[]> {
  try {
    return await readdir(join(UPLOAD_ROOT, userId));
  } catch {
    return [];
  }
}
