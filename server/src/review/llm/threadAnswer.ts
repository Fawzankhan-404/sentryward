import type { Config } from "../config/schema.ts";
import { THREAD_ANSWER_SYSTEM_PROMPT, threadAnswerUserPrompt, type ThreadQuestion } from "./prompt.ts";
import { generateWithFallback, modelChain, type Generate } from "./providers.ts";
import { repairThreadAnswerOutput, threadAnswerOutputSchema } from "./schemas.ts";

// One short in-thread answer: bounded at the model and again on the text.
const ANSWER_OUTPUT_TOKENS = 600;
export const MAX_ANSWER_CHARS = 1500;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// The answer as it may be posted: cut to length with any code block it cuts
// open closed again, so the footer and marker after it are not swallowed; and
// with any line that would read as a Sentryward command defused, so a reply can
// never make the bot command itself. Commands only count at the start of a
// line, so inside a code block a leading space defuses one without the stray
// backticks that would show there.
export function boundAnswer(text: string): string {
  const trimmed = text.trim();
  const cut = trimmed.length > MAX_ANSWER_CHARS ? `${trimmed.slice(0, MAX_ANSWER_CHARS).trimEnd()}…` : trimmed;
  let fence: string | null = null;
  const lines: string[] = [];
  for (const line of cut.split("\n")) {
    const opener = FENCE.exec(line)?.[1];
    if (opener) {
      // A fence closes on the same character, at least as long as it opened.
      if (fence === null) fence = opener;
      else if (opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      lines.push(line);
    } else if (fence !== null) {
      lines.push(line.replace(/^\/sentryward/i, " /sentryward"));
    } else {
      lines.push(line.replace(/^(\s*)\/sentryward/i, "$1`/sentryward`"));
    }
  }
  if (fence !== null) lines.push(fence);
  return lines.join("\n");
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
