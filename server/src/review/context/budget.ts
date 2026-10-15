import type { Config } from "../config/schema.ts";

// A deliberately rough estimate. Exact counts differ per provider and tokenizer;
// the budget keeps a safety margin rather than pretending to precision.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const CONTEXT_WINDOW: Record<string, number> = {
  anthropic: 200_000,
  openai: 200_000,
  google: 1_000_000,
  ollama: 128_000,
};

// Very long prompts review worse than several focused ones, so a pass never
// carries more diff than this even when the window would allow it.
export const MAX_DIFF_TOKENS_PER_PASS = 60_000;
// Surrounding code helps a pass judge the diff but must not bury it.
export const MAX_CONTEXT_TOKENS_PER_PASS = 20_000;
const SAFETY_TOKENS = 2_000;
const MIN_DIFF_TOKENS = 2_000;

function promptCeiling(config: Config): number {
  const provider = config.llm.model.split("/")[0] ?? "anthropic";
  return config.llm.contextBudget ?? (CONTEXT_WINDOW[provider] ?? 128_000) - config.llm.maxTokens;
}

// Diff tokens one pass may carry once the fixed prompt and the reply are paid for.
export function diffTokenBudget(config: Config, overheadTokens: number): number {
  return Math.max(MIN_DIFF_TOKENS, Math.min(MAX_DIFF_TOKENS_PER_PASS, promptCeiling(config) - overheadTokens - SAFETY_TOKENS));
}

// Context only gets what a pass has left once its diff is planned, so it can
// never push a hunk out of the review.
export function contextTokenBudget(config: Config, overheadTokens: number, diffTokens: number): number {
  const left = promptCeiling(config) - overheadTokens - SAFETY_TOKENS - diffTokens;
  return Math.max(0, Math.min(MAX_CONTEXT_TOKENS_PER_PASS, left));
}
