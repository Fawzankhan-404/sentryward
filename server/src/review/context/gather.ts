import type { ChangeSet } from "../core/models.ts";
import { limiter, mapLimit } from "../core/mapLimit.ts";
import type { Chunk, ChunkPart } from "./chunk.ts";
import {
  CONTEXT_PRIORITY,
  MAX_CONTEXT_FILE_CHARS,
  declarationScope,
  fileContextBlocks,
  fileLines,
  rangesBlock,
  type ContextBlock,
} from "./fileContext.ts";
import { callSites, declarationLine, moduleCandidates, partSymbols, relativeImports } from "./symbols.ts";

// Where context comes from. The worker reads through the forge (and its
// cache); without a source a review sees the diff alone.
export interface ContextSource {
  // A file at the change's head revision, or null when it is not there.
  readFile(path: string): Promise<string | null>;
  // Paths of files mentioning `term`, best match first. May search another
  // revision than the head: GitHub only indexes the default branch.
  searchCode(term: string): Promise<string[]>;
}

export interface GatherInput {
  chunks: Chunk[];
  changeSet: ChangeSet;
  source: ContextSource;
  // Context tokens a pass may still take once its diff is paid for.
  budgetFor: (chunk: Chunk) => number;
  concurrency: number;
}

export interface GatheredContext {
  // Rendered context per chunk, in chunk order.
  contexts: string[];
  warnings: string[];
}

const MAX_DEFINITIONS_PER_PART = 6;
// Code search is the costliest lookup and GitHub rate-limits it hard, so a
// review searches for at most this many names, the first the change defines.
const MAX_CALLER_SEARCHES = 5;
const MAX_CALLER_FILES = 3;
const MAX_CALL_SITES_PER_FILE = 3;
const MAX_LISTED_PATHS = 5;
// Below this a pass has no room for even a short block, so nothing is fetched for it.
const MIN_CONTEXT_TOKENS = 50;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Highest priority first; a block that does not fit is skipped and smaller
// ones after it are still tried. What is left out is never an omission: the
// diff itself was reviewed in full.
export function fillContext(blocks: ContextBlock[], budget: number): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  let used = 0;
  for (const block of [...blocks].sort((a, b) => a.priority - b.priority)) {
    if (seen.has(block.text)) continue;
    seen.add(block.text);
    const cost = block.tokens + 1;
    if (used + cost > budget) continue;
    texts.push(block.text);
    used += cost;
  }
  return texts.join("\n\n");
}

// Best effort throughout: a read or search that fails leaves that context
// out with a warning, and the pass reviews the diff alone.
export async function gatherContext(input: GatherInput): Promise<GatheredContext> {
  const { chunks, changeSet, source } = input;
  const failedReads = new Set<string>();
  let searchError: string | undefined;

  // Passes gather side by side, and each fans out over its files, so the
  // forge calls themselves share one limit.
  const forgeCall = limiter(input.concurrency);
  // Every path is read once per review, however many passes want it.
  const reads = new Map<string, Promise<string[] | null>>();
  const read = (path: string): Promise<string[] | null> => {
    let pending = reads.get(path);
    if (!pending) {
      pending = forgeCall(() => source.readFile(path)).then(
        (text) => (text === null || text.length > MAX_CONTEXT_FILE_CHARS ? null : fileLines(text)),
        () => {
          failedReads.add(path);
          return null;
        },
      );
      reads.set(path, pending);
    }
    return pending;
  };
  const searches = new Map<string, Promise<string[]>>();
  const search = (term: string): Promise<string[]> => {
    let pending = searches.get(term);
    if (!pending) {
      pending = forgeCall(() => source.searchCode(term)).catch((err: unknown) => {
        searchError ??= message(err);
        return [];
      });
      searches.set(term, pending);
    }
    return pending;
  };

  const changed = new Set(changeSet.files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]));
  const searchable = new Set(
    [...new Set(chunks.flatMap((chunk) => chunk.parts.flatMap((part) => partSymbols(part.hunks).defined)))].slice(
      0,
      MAX_CALLER_SEARCHES,
    ),
  );

  async function definitionBlocks(part: ChunkPart, content: string, inChunk: Set<string>): Promise<ContextBlock[]> {
    const bindings = relativeImports(content);
    const wanted = partSymbols(part.hunks)
      .called.filter((name) => bindings.has(name))
      .slice(0, MAX_DEFINITIONS_PER_PART);
    const found = await Promise.all(
      wanted.map(async (name) => {
        const binding = bindings.get(name)!;
        for (const path of moduleCandidates(part.file.path, binding.module)) {
          // The pass already shows that file's diff and scopes.
          if (inChunk.has(path)) return undefined;
          const lines = await read(path);
          if (!lines) continue;
          const line = declarationLine(lines, binding.exported);
          if (line === undefined) return undefined;
          return rangesBlock(path, `definition of ${name}`, CONTEXT_PRIORITY.definition, lines, [
            declarationScope(lines, line),
          ]);
        }
        return undefined;
      }),
    );
    return found.filter((block): block is ContextBlock => !!block);
  }

  async function callerBlocks(part: ChunkPart): Promise<ContextBlock[]> {
    const names = partSymbols(part.hunks).defined.filter((name) => searchable.has(name));
    const found = await Promise.all(
      names.map(async (name) => {
        const paths = (await search(name)).filter((path) => !changed.has(path)).slice(0, MAX_CALLER_FILES);
        return Promise.all(
          paths.map(async (path) => {
            const lines = await read(path);
            if (!lines) return undefined;
            const sites = callSites(lines, name, MAX_CALL_SITES_PER_FILE);
            return sites.length
              ? rangesBlock(path, `call sites of ${name}`, CONTEXT_PRIORITY.callers, lines, sites)
              : undefined;
          }),
        );
      }),
    );
    return found.flat().filter((block): block is ContextBlock => !!block);
  }

  async function partBlocks(part: ChunkPart, inChunk: Set<string>): Promise<ContextBlock[]> {
    if (part.file.changeType === "deleted" || part.file.isBinary) return [];
    const lines = await read(part.file.path);
    const blocks = lines ? fileContextBlocks(part.file, part.hunks, lines) : [];
    if (lines) blocks.push(...(await definitionBlocks(part, lines.join("\n"), inChunk)));
    blocks.push(...(await callerBlocks(part)));
    return blocks;
  }

  const contexts = await mapLimit(chunks, input.concurrency, async (chunk) => {
    const budget = input.budgetFor(chunk);
    if (budget < MIN_CONTEXT_TOKENS) return "";
    const inChunk = new Set(chunk.parts.map((part) => part.file.path));
    const blocks = (await Promise.all(chunk.parts.map((part) => partBlocks(part, inChunk)))).flat();
    return fillContext(blocks, budget);
  });

  const warnings: string[] = [];
  if (failedReads.size) {
    const paths = [...failedReads].sort();
    const listed = paths.slice(0, MAX_LISTED_PATHS).join(", ");
    const more = paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : "";
    warnings.push(`Review context could not be read for ${listed}${more}; the diff was reviewed without it`);
  }
  if (searchError) warnings.push(`Caller search failed, so passes saw no call sites: ${searchError}`);
  return { contexts, warnings };
}
