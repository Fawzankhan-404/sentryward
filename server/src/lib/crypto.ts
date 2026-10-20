import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.ts";

// AES-256-GCM for forge tokens and LLM keys at rest. Output is
// `v1.<iv>.<tag>.<ciphertext>` in base64url, so the format can change later
// without guessing what an old row holds.
const VERSION = "v1";
const key = Buffer.from(env.ENCRYPTION_KEY, "hex");

// Thrown for a payload this server cannot read: an unknown format, or one
// written under a different ENCRYPTION_KEY (GCM authentication then fails).
// Callers catch it to show a re-enter prompt instead of a raw crypto error.
export class DecryptError extends Error {}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new DecryptError("Unrecognised encrypted payload");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DecryptError("Stored secret cannot be decrypted with the current ENCRYPTION_KEY");
  }
}
