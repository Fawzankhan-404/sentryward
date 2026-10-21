import type { Config } from "../config/schema.ts";
import { THREAD_ANSWER_SYSTEM_PROMPT, threadAnswerUserPrompt, type ThreadQuestion } from "./prompt.ts";
import { generateWithFallback, modelChain, type Generate } from "./providers.ts";
import { repairThreadAnswerOutput, threadAnswerOutputSchema } from "./schemas.ts";

// One short in-thread answer: bounded at the model and again on the text.
const ANSWER_OUTPUT_TOKENS = 600;
export const MAX_ANSWER_CHARS = 1500;

// The answer as it may be posted: cut to length, and with any line that would
// read as a Sentryward command defused, so a reply can never make the bot
// command itself.
export function boundAnswer(text: string): string {
  const trimmed = text.trim();
  const cut = trimmed.length > MAX_ANSWER_CHARS ? `${trimmed.slice(0, MAX_ANSWER_CHARS).trimEnd()}…` : trimmed;
  return cut.replace(/^(\s*)\/sentryward/gim, "$1`/sentryward`");
}

export async function answerThreadQuestion(
  generate: Generate,
  question: ThreadQuestion,
  config: Config,
): Promise<string> {
  const response = await generateWithFallback(generate, modelChain(config.llm, "review"), {
    system: THREAD_ANSWER_SYSTEM_PROMPT,
    prompt: threadAnswerUserPrompt(question),
    schema: threadAnswerOutputSchema,
    schemaName: "thread_answer",
    repair: repairThreadAnswerOutput,
    temperature: config.llm.temperature,
    maxOutputTokens: Math.min(config.llm.maxTokens, ANSWER_OUTPUT_TOKENS),
  });
  return boundAnswer(response.object.answer);
}
