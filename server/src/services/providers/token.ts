import { DecryptError, decrypt } from "../../lib/crypto.ts";
import { HttpError } from "../../lib/httpError.ts";

// A token saved under another ENCRYPTION_KEY can only be fixed by connecting
// again, so it reads as that (and as a revoked connection) rather than a 500.
export class UnreadableTokenError extends HttpError {
  constructor(forge: string) {
    super(409, `The stored ${forge} token can't be decrypted; reconnect this account`);
  }
}

export function decryptToken(encryptedToken: string, forge: string): string {
  try {
    return decrypt(encryptedToken);
  } catch (error) {
    if (error instanceof DecryptError) throw new UnreadableTokenError(forge);
    throw error;
  }
}
