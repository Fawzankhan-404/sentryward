import type { ChangedFile, Hunk, Omission } from "../core/models.ts";
import { estimateTokens } from "./budget.ts";
import { renderFileDiff, renderFileHeader, renderHunk } from "./diffText.ts";

export interface ChunkPart {
  file: ChangedFile;
  hunks: Hunk[];
}

export interface Chunk {
  index: number;
  parts: ChunkPart[];
  text: string;
  // Diff tokens only; read-only surrounding code is added after planning.
  tokens: number;
  // Rendered CONTEXT blocks for this pass, empty when there are none.
  context: string;
}

export interface ChunkPlan {
  chunks: Chunk[];
  omissions: Omission[];
}

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$/i;
const SUPPORT_PATH = /\.(md|mdx|txt|rst|ya?ml|json|toml|ini|lock)$|(^|\/)docs?\//i;

// Code that defines behaviour is read first, then the tests that pin it, then
// docs and config, so a truncated review loses the least important part.
function priority(file: ChangedFile): number {
  if (TEST_PATH.test(file.path)) return 1;
  if (SUPPORT_PATH.test(file.path)) return 2;
  return 0;
}

function lineRange(hunks: Hunk[]): string {
  const first = hunks[0]!;
  const last = hunks.at(-1)!;
  return `lines ${first.newStart}-${last.newStart + Math.max(last.newLines - 1, 0)}`;
}

// Splits a file that does not fit one pass into hunk groups that each do. A
// single hunk larger than a whole pass cannot be reviewed meaningfully in part.
function fitFile(file: ChangedFile, budget: number, omissions: Omission[]): ChunkPart[] {
  if (estimateTokens(renderFileDiff(file)) <= budget) {
    return [{ file, hunks: file.hunks }];
  }
  const headerTokens = estimateTokens(renderFileHeader(file));
  const parts: ChunkPart[] = [];
  let current: Hunk[] = [];
  let tokens = headerTokens;
  for (const hunk of file.hunks) {
    const hunkTokens = estimateTokens(renderHunk(hunk)) + 1;
    if (headerTokens + hunkTokens > budget) {
      omissions.push({ path: file.path, reason: "too_large", detail: lineRange([hunk]) });
      continue;
    }
    if (tokens + hunkTokens > budget && current.length) {
      parts.push({ file, hunks: current });
      current = [];
      tokens = headerTokens;
    }
    current.push(hunk);
    tokens += hunkTokens;
  }
  if (current.length) parts.push({ file, hunks: current });
  return parts;
}

// Greedy packing of files (or file parts) into passes of at most `budget`
// tokens, capped at `maxChunks`. Whatever does not fit is reported as an
// omission with its line range, never dropped silently.
export function planChunks(files: ChangedFile[], budget: number, maxChunks: number): ChunkPlan {
  const omissions: Omission[] = [];
  const ordered = files
    .map((file, order) => ({ file, order }))
    .sort((a, b) => priority(a.file) - priority(b.file) || a.order - b.order)
    .map(({ file }) => file);

  const chunks: Chunk[] = [];
  let parts: ChunkPart[] = [];
  let texts: string[] = [];
  let tokens = 0;

  const close = () => {
    if (!parts.length) return;
    const text = texts.join("\n\n");
    chunks.push({ index: chunks.length + 1, parts, text, tokens: estimateTokens(text), context: "" });
    parts = [];
    texts = [];
    tokens = 0;
  };

  const overflow: ChunkPart[] = [];
  for (const file of ordered) {
    for (const part of fitFile(file, budget, omissions)) {
      const text = renderFileDiff(part.file, part.hunks);
      const partTokens = estimateTokens(text) + 1;
      if (tokens + partTokens > budget) close();
      if (chunks.length >= maxChunks) {
        overflow.push(part);
        continue;
      }
      parts.push(part);
      texts.push(text);
      tokens += partTokens;
    }
  }
  close();

  for (const part of overflow) {
    const whole = part.hunks.length === part.file.hunks.length;
    omissions.push({
      path: part.file.path,
      reason: "budget",
      detail: whole ? `more than ${maxChunks} review passes needed` : lineRange(part.hunks),
    });
  }
  return { chunks, omissions };
}
