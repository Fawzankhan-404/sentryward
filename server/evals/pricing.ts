import type { LlmUsage } from "../src/review/core/models.ts";

// USD per million tokens, input then output. Anthropic first-party list
// prices as of 2026-10; anything else is priced with --price or left unpriced
// rather than guessed. Haiku 5.5 is the up-to-100K-prompt tier, which a review
// pass stays under.
export interface Price {
  input: number;
  output: number;
}

export const PRICES: Record<string, Price> = {
  "anthropic/claude-opus-5-5": { input: 4, output: 20 },
  "anthropic/claude-sonnet-5-5": { input: 2, output: 10 },
  "anthropic/claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

// "<input>,<output>", e.g. "2,10".
export function parsePrice(text: string): Price {
  const usage = `--price expects "<input>,<output>" in USD per million tokens, got "${text}"`;
  // Number("") is 0 and Number("Infinity") is Infinity, so both need
  // rejecting explicitly: one would price tokens as free, the other would
  // serialise totals as null.
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new Error(usage);
  const [input, output] = parts.map(Number) as [number, number];
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    throw new Error(usage);
  }
  return { input, output };
}

// null as soon as one call's model has no price: a partial sum would read as
// the whole cost.
export function costOf(usage: LlmUsage[], override?: Price): number | null {
  let total = 0;
  for (const call of usage) {
    const price = override ?? PRICES[call.model];
    if (!price) return null;
    total += (call.inputTokens * price.input + call.outputTokens * price.output) / 1_000_000;
  }
  return total;
}
