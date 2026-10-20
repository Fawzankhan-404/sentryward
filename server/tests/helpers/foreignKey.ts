import { createCipheriv, randomBytes } from "node:crypto";

// A well-formed `v1.` payload sealed with a key other than ENCRYPTION_KEY, as a
// row looks after the server's key changes.
export function encryptWithOtherKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", randomBytes(32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
}
