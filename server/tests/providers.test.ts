import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGenerate, missingKeys } from "../src/review/llm/providers.ts";
import { fetchStub } from "./helpers/fetchStub.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = (model: string) => ({
  model,
  system: "s",
  prompt: "p",
  schema: z.object({ ok: z.boolean() }),
  schemaName: "result",
  temperature: 0,
  maxOutputTokens: 100,
});

// An OpenAI streaming (SSE) body: the engine now streams the proxied path, so
// the stub must speak `text/event-stream`. Each chunk is JSON-stringified onto
// one `data:` line, so prose/fence payloads with newlines never break framing.
const chatCompletionChunk = (extra: Record<string, unknown>) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "cx/gpt-5.6-sol(medium)",
    ...extra,
  });

const sse = (content: string) =>
  [
    `data: ${chatCompletionChunk({
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}`,
    `data: ${chatCompletionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    `data: ${chatCompletionChunk({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");

const streamRoute = (url: RegExp, content: string) => ({
  method: "POST",
  url,
  body: sse(content),
  headers: { "content-type": "text/event-stream" },
});

describe("createGenerate with an endpoint", () => {
  it("sends OpenAI models to its chat completions with the chosen key and the router id", async () => {
    const { fetch, calls } = fetchStub([
      streamRoute(/^http:\/\/router\.test\/v1\/chat\/completions$/, '{"ok":true}'),
    ]);
    vi.stubGlobal("fetch", fetch);

    const generate = createGenerate(
      { openai: "sk-real" },
      { baseUrl: "http://router.test/v1", apiKey: "router-key" },
      { openai: "http://credential-host.test/v1" },
    );
    const response = await generate(request("openai/cx/gpt-5.6-sol(medium)"));

    expect(response.object).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer router-key");
    expect(JSON.parse(calls[0]!.body!).model).toBe("cx/gpt-5.6-sol(medium)");
  });

  it("sends Anthropic models to the same endpoint in their own format", async () => {
    const { fetch, calls } = fetchStub([{ method: "POST", url: /^http:\/\/router\.test\/v1\/messages$/, status: 400 }]);
    vi.stubGlobal("fetch", fetch);

    const generate = createGenerate({}, { baseUrl: "http://router.test/v1" });
    await expect(generate({ ...request("anthropic/claude-sonnet-5-5") })).rejects.toThrow();

    expect(calls[0]!.url).toBe("http://router.test/v1/messages");
  });

  it("uses an Ollama credential host through chat completions without a key", async () => {
    const { fetch, calls } = fetchStub([
      streamRoute(/^http:\/\/ollama\.test\/v1\/chat\/completions$/, '{"ok":true}'),
    ]);
    vi.stubGlobal("fetch", fetch);

    const generate = createGenerate({}, undefined, { ollama: "http://ollama.test/v1" });
    const response = await generate(request("ollama/qwen3"));

    expect(response.object).toEqual({ ok: true });
    expect(calls[0]!.headers.authorization).toBe("Bearer unused");
    expect(JSON.parse(calls[0]!.body!).model).toBe("qwen3");
  });
});

// The reply 9router gave to a strict json_schema request: it dropped the schema.
const PROSE_REPLY =
  "Added a null check in `UserService.php` before accessing `$user->email`, preventing null-reference errors when no user is found.";

describe("createGenerate behind a proxy", () => {
  const router = () => createGenerate({}, { baseUrl: "http://router.test/v1", apiKey: "router-key" });
  const stubReply = (content: string) => {
    const stub = fetchStub([streamRoute(/^http:\/\/router\.test\/v1\/chat\/completions$/, content)]);
    vi.stubGlobal("fetch", stub.fetch);
    return stub;
  };

  it("describes the schema in the prompt instead of relying on response_format", async () => {
    const { calls } = stubReply('{"ok":true}');

    await router()(request("openai/cx/gpt-5.6-sol"));

    const body = JSON.parse(calls[0]!.body!);
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Respond with a single JSON object only");
    expect(body.messages[0].content).toContain('"ok":{"type":"boolean"}');
  });

  it("parses JSON wrapped in prose and a code fence", async () => {
    stubReply('Here is the result:\n```json\n{"ok": true}\n```\nDone.');

    const response = await router()(request("openai/cx/gpt-5.6-sol"));

    expect(response.object).toEqual({ ok: true });
    expect(response.inputTokens).toBe(12);
  });

  it("applies the request's repair before validating", async () => {
    stubReply('{"OK": "yes"}');

    const response = await router()({
      ...request("openai/cx/gpt-5.6-sol"),
      repair: (raw) => ({ ok: (raw as { OK: string }).OK === "yes" }),
    });

    expect(response.object).toEqual({ ok: true });
  });

  it("fails a prose reply with an excerpt of what came back", async () => {
    stubReply(PROSE_REPLY);

    await expect(router()(request("openai/cx/gpt-5.6-sol"))).rejects.toThrow(
      /No object generated: reply contained no JSON object\. Reply: Added a null check/,
    );
  });
});

describe("createGenerate against an official API", () => {
  it("keeps the provider's structured output", async () => {
    const { fetch, calls } = fetchStub([
      {
        method: "POST",
        url: /^https:\/\/api\.openai\.com\/v1\/responses$/,
        body: {
          id: "resp_1",
          created_at: 0,
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
    ]);
    vi.stubGlobal("fetch", fetch);

    const response = await createGenerate({ openai: "sk-real" })(request("openai/gpt-5.5"));

    expect(response.object).toEqual({ ok: true });
    expect(JSON.parse(calls[0]!.body!).text.format).toMatchObject({ type: "json_schema", name: "result" });
  });
});

describe("missingKeys", () => {
  it("asks for no key behind an endpoint", () => {
    const models = ["openai/gpt-5", "anthropic/claude-sonnet-5-5"];
    expect(missingKeys(models, {}, { baseUrl: "http://router.test/v1" })).toEqual([]);
    expect(missingKeys(models, { openai: "k" })).toEqual(["anthropic"]);
    expect(missingKeys(["ollama/qwen3"], {}, undefined, { ollama: "http://ollama.test/v1" })).toEqual([]);
  });
});
