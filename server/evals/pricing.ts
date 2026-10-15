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
  const [input, output, ...rest] = text.split(",").map((part) => Number(part.trim()));
  if (rest.length > 0 || input === undefined || output === undefined || !(input >= 0) || !(output >= 0)) {
    throw new Error(`--price expects "<input>,<output>" in USD per million tokens, got "${text}"`);
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
