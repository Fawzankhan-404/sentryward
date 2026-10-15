import { logger } from "../logger.ts";

export interface BillingConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export function createBillingClient(config: BillingConfig) {
  logger.info({ baseUrl: config.baseUrl }, "billing client ready");

  return {
    async charge(customerId: string, amountCents: number) {
      const request = {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ customerId, amountCents }),
        signal: AbortSignal.timeout(config.timeoutMs),
      };
      const response = await fetch(`${config.baseUrl}/charges`, request);
      if (!response.ok) {
        logger.error({ status: response.status, request }, "charge failed");
        throw new Error(`charge failed: ${response.status}`);
      }
      return response.json();
    },
  };
}
