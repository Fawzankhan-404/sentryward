import type { Config } from "../config/schema.ts";
import type { ChangeSet, Finding, LlmUsage } from "../core/models.ts";
import { VERIFY_SYSTEM_PROMPT, verifyUserPrompt } from "./prompt.ts";
import { generateWithFallback, type Generate } from "./providers.ts";
import { repairVerificationOutput, verificationOutputSchema, type VerificationOutput } from "./schemas.ts";

// A verdict and a sentence need little room.
const VERIFY_OUTPUT_TOKENS = 1000;

export interface FindingVerification extends VerificationOutput {
  usage: LlmUsage;
}

export async function verifyFinding(
  generate: Generate,
  changeSet: ChangeSet,
  finding: Finding,
  code: { diff: string; context: string },
  config: Config,
): Promise<FindingVerification> {
  const response = await generateWithFallback(generate, [config.llm.model, ...config.llm.fallbackModels], {
    system: VERIFY_SYSTEM_PROMPT,
    prompt: verifyUserPrompt(changeSet, finding, code.diff, code.context),
    schema: verificationOutputSchema,
    schemaName: "verification",
    repair: repairVerificationOutput,
    temperature: config.llm.temperature,
    maxOutputTokens: Math.min(config.llm.maxTokens, VERIFY_OUTPUT_TOKENS),
  });
  return {
    verdict: response.object.verdict,
    reason: response.object.reason.trim(),
    usage: {
      purpose: "verify",
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      latencyMs: response.latencyMs,
    },
  };
}
