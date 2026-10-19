import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import type { Config } from "../config/schema.ts";
import { excerpt, formatInstruction, parseLenient } from "./format.ts";

export const PROVIDERS = ["anthropic", "openai", "google", "ollama"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type ApiKeys = Partial<Record<ProviderName, string>>;
export type ProviderBaseUrls = Partial<Record<ProviderName, string>>;
// A proxy every model call goes to instead of the providers' official APIs,
// with the key to send it when the config picked one.
export interface Endpoint {
  baseUrl: string;
  apiKey?: string;
}

// A proxy such as 9router may need no key, but the SDKs refuse to build a
// client without one.
const NO_KEY = "unused";

export function providerOf(model: string): ProviderName {
  const provider = model.split("/")[0];
  if (!PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(`Unsupported model provider in "${model}"`);
  }
  return provider as ProviderName;
}

// Behind an endpoint no provider is missing a key: the endpoint decides
// whether it needs one.
export function missingKeys(
  models: string[],
  keys: ApiKeys,
  endpoint?: Endpoint,
  baseUrls: ProviderBaseUrls = {},
): ProviderName[] {
  if (endpoint) return [];
  return [...new Set(models.map(providerOf))].filter((provider) => !keys[provider] && !baseUrls[provider]);
}

interface ResolvedModel {
  model: LanguageModel;
  // Whether the provider itself enforces the output schema. Proxies may drop
  // `response_format` silently (9router does), so anything behind a base URL
  // is asked for JSON in the prompt and parsed leniently instead.
  native: boolean;
}

function languageModel(
  model: string,
  keys: ApiKeys,
  endpoint?: Endpoint,
  baseUrls: ProviderBaseUrls = {},
): ResolvedModel {
  const provider = providerOf(model);
  const modelId = model.slice(provider.length + 1);
  const baseURL = endpoint?.baseUrl ?? baseUrls[provider];
  const apiKey = endpoint
    ? (endpoint.apiKey ?? keys[provider] ?? NO_KEY)
    : (keys[provider] ?? (baseURL ? NO_KEY : undefined));
  if (!apiKey) throw new Error(`No API key for ${provider}`);
  const native = !baseURL;
  switch (provider) {
    case "anthropic":
      return { model: createAnthropic({ apiKey, baseURL })(modelId), native };
    case "openai": {
      const openai = createOpenAI({ apiKey, baseURL });
      // OpenAI-compatible proxies speak chat completions, not the Responses API
      // the SDK defaults to.
      return { model: baseURL ? openai.chat(modelId) : openai(modelId), native };
    }
    case "google":
      return { model: createGoogleGenerativeAI({ apiKey, baseURL })(modelId), native };
    case "ollama": {
      const ollama = createOpenAI({ apiKey, baseURL });
      return { model: ollama.chat(modelId), native: false };
    }
  }
}

export interface GenerateRequest<T> {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  temperature: number;
  maxOutputTokens: number;
  // Fixes predictable model mistakes in a reply the provider did not enforce
  // the schema on, before it is validated.
  repair?: (raw: unknown) => unknown;
  // Cancels the request, e.g. when the PR/MR is closed mid-review.
  abortSignal?: AbortSignal;
}

export interface GenerateResponse<T> {
  object: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

// The one seam between the engine and a model provider. Tests pass their own.
export type Generate = <T>(request: GenerateRequest<T>) => Promise<GenerateResponse<T>>;

function failure(reason: string, text: string | undefined): Error {
  return new Error(`No object generated: ${reason}. Reply: ${excerpt(text)}`);
}

export function createGenerate(keys: ApiKeys, endpoint?: Endpoint, baseUrls: ProviderBaseUrls = {}): Generate {
  return async <T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>> => {
    const started = Date.now();
    const { model, native } = languageModel(request.model, keys, endpoint, baseUrls);
    const call = {
      model,
      // The format goes in the prompt even when the provider enforces it, so a
      // reply that slips past enforcement is still likely to parse.
      system: `${request.system}\n\n${formatInstruction(request.schema, request.schemaName)}`,
      prompt: request.prompt,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
    };
    const respond = (object: T, usage: { inputTokens?: number; outputTokens?: number } | undefined) => ({
      object,
      model: request.model,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      latencyMs: Date.now() - started,
    });
    const lenient = (text: string | undefined) => {
      try {
        return parseLenient(text ?? "", request.schema, request.repair);
      } catch (err) {
        throw failure(err instanceof Error ? err.message : String(err), text);
      }
    };

    if (!native) {
      const result = await generateText(call);
      return respond(lenient(result.text), result.usage);
    }
    try {
      const result = await generateText({
        ...call,
        output: Output.object({ schema: request.schema, name: request.schemaName }),
      });
      return respond(result.output as T, result.usage);
    } catch (err) {
      // A near-miss the provider let through is repaired rather than lost.
      if (NoObjectGeneratedError.isInstance(err)) return respond(lenient(err.text), err.usage);
      throw err;
    }
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Tries the primary model, then each fallback in order. Every model's error is
// kept so the primary's failure is not hidden behind the last fallback's.
export type ModelPurpose = "review" | "walkthrough" | "verify";

// The models a call tries, in order: the purpose's own model when one is set,
// otherwise `model`, then the shared fallbacks.
export function modelChain(llm: Config["llm"], purpose: ModelPurpose): string[] {
  const primary =
    (purpose === "walkthrough" ? llm.walkthroughModel : purpose === "verify" ? llm.verifyModel : null) ?? llm.model;
  return [...new Set([primary, ...llm.fallbackModels])];
}

export async function generateWithFallback<T>(
  generate: Generate,
  models: string[],
  request: Omit<GenerateRequest<T>, "model">,
): Promise<GenerateResponse<T>> {
  const errors: unknown[] = [];
  for (const model of models) {
    try {
      return await generate({ ...request, model });
    } catch (err) {
      // A cancelled review has no use for the fallbacks either.
      if (request.abortSignal?.aborted) throw err;
      errors.push(err);
    }
  }
  if (errors.length === 1) throw errors[0] instanceof Error ? errors[0] : new Error(message(errors[0]));
  throw new Error(errors.map((err, i) => `${models[i]}: ${message(err)}`).join(" | "));
}

// Every request made through the result carries the signal, and none starts
// once it has fired, so a cancelled review stops spending model calls.
export function abortableGenerate(generate: Generate, signal: AbortSignal): Generate {
  return async (request) => {
    signal.throwIfAborted();
    return generate({ ...request, abortSignal: signal });
  };
}
