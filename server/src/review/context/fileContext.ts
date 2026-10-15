import type { ChangedFile, Hunk } from "../core/models.ts";
import { estimateTokens } from "./budget.ts";

// Read-only code around the diff, taken from the new version of a file. It
// never carries diff markers, so the line-number contract of the diff holds
// and nothing here can be mistaken for a line the change touched.

export interface LineRange {
  start: number;
  end: number;
}

export interface ContextBlock {
  path: string;
  label: string;
  // Lower goes in first; a pass takes blocks in this order until it is full.
  priority: number;
  text: string;
  tokens: number;
}

export const CONTEXT_PRIORITY = { scope: 0, imports: 1, definition: 2, callers: 3 } as const;

// Generated or vendored files this large say little per token.
export const MAX_CONTEXT_FILE_CHARS = 400_000;
const MAX_SCOPE_UP = 150;
const MAX_SCOPE_DOWN = 80;
// Used when no enclosing declaration is found within the limits above.
const FALLBACK_LINES = 30;
const MAX_IMPORT_SCAN = 200;
const MAX_IMPORT_LINES = 60;

// `import(` is a dynamic import expression; Go's grouped `import (` is not.
const IMPORT_LINE =
  /^\s*(?:import\b(?!\()|from\s+\S+\s+import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|(?:const|let|var)\s+.+=\s*require\(|require(?:_relative)?\s+["']|use\s|using\s|#include\b|package\s|@import\b)/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!include)|--|"""|''')/;
// A line that closes a scope rather than starting the next one.
const CLOSER = /^(?:[}\])]|end\b|fi\b|esac\b|done\b)/;

export function fileLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function indentOf(line: string | undefined): number | undefined {
  if (line === undefined || !line.trim()) return undefined;
  return line.length - line.trimStart().length;
}

// Where a scope opened at `indent` ends: the first later line at that
// indentation or less, kept when it is a closing bracket or keyword. Scopes
// are found by indentation alone, which holds across languages without a
// parser and degrades to a fixed window when it does not.
function scopeEnd(lines: string[], indent: number, after: number): number | undefined {
  const limit = Math.min(lines.length, after + MAX_SCOPE_DOWN);
  let end: number | undefined;
  for (let n = after + 1; n <= limit; n++) {
    const own = indentOf(lines[n - 1]);
    if (own === undefined || own > indent) continue;
    end = CLOSER.test(lines[n - 1]!.trim()) ? n : n - 1;
    break;
  }
  if (end === undefined) {
    if (limit < lines.length) return undefined;
    end = lines.length;
  }
  while (end > after && indentOf(lines[end - 1]) === undefined) end -= 1;
  return end;
}

// The outermost declaration around lines start..end that starts within
// MAX_SCOPE_UP lines, through to where it closes: the function, and the class
// too when it is short enough.
export function enclosingScope(lines: string[], start: number, end: number): LineRange {
  const first = Math.max(1, Math.min(start, lines.length));
  const last = Math.min(lines.length, Math.max(first, end));
  // A closing line sits one level out from the body it closes; counting it
  // would put a hunk ending in a function's "}" at the top level.
  let level = Infinity;
  for (let n = first; n <= last; n++) {
    const own = indentOf(lines[n - 1]);
    if (own !== undefined && !CLOSER.test(lines[n - 1]!.trim())) level = Math.min(level, own);
  }

  let top: number | undefined;
  let topIndent = level;
  for (let n = first - 1; n >= Math.max(1, first - MAX_SCOPE_UP); n--) {
    const own = indentOf(lines[n - 1]);
    if (own === undefined || own >= topIndent) continue;
    top = n;
    topIndent = own;
    if (own === 0) break;
  }
  if (top === undefined) {
    // Already at the top level: the hunk's own lines open the scope.
    if (level === 0) top = first;
    else return { start: Math.max(1, first - FALLBACK_LINES), end: Math.min(lines.length, last + FALLBACK_LINES) };
  }
  const bottom = scopeEnd(lines, topIndent === Infinity ? 0 : topIndent, last) ?? Math.min(lines.length, last + FALLBACK_LINES);
  return { start: top, end: Math.max(bottom, last) };
}

// A declaration and its body, e.g. the function a changed line calls.
export function declarationScope(lines: string[], line: number): LineRange {
  const indent = indentOf(lines[line - 1]) ?? 0;
  return { start: line, end: scopeEnd(lines, indent, line) ?? Math.min(lines.length, line + FALLBACK_LINES) };
}

// The import block at the top of the file. A preamble (licence header,
// docstring) may come first; the block ends at the first top-level line
// that is neither an import nor the end of a multi-line one.
export function importBlock(lines: string[]): LineRange | undefined {
  let last = 0;
  for (let n = 1; n <= Math.min(lines.length, MAX_IMPORT_SCAN); n++) {
    const line = lines[n - 1]!;
    if (IMPORT_LINE.test(line)) {
      last = n;
      continue;
    }
    if (!last || !line.trim() || COMMENT_LINE.test(line)) continue;
    // Inside or closing a multi-line import: `import {` ... `} from "./x"`,
    // or Go's `import (` ... `)`.
    if (indentOf(line)! > 0 || CLOSER.test(line.trim())) {
      last = n;
      continue;
    }
    break;
  }
  return last ? { start: 1, end: Math.min(last, MAX_IMPORT_LINES) } : undefined;
}

// Merges overlapping or adjacent ranges.
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

// New-file lines a hunk already shows, added or unchanged.
export function shownLines(hunks: Hunk[]): Set<number> {
  const shown = new Set<number>();
  for (const hunk of hunks) {
    for (let n = hunk.newStart; n < hunk.newStart + hunk.newLines; n++) shown.add(n);
  }
  return shown;
}

function numbersIn(range: LineRange, exclude: Set<number>): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) if (!exclude.has(n)) numbers.push(n);
  return numbers;
}

export function renderContext(path: string, label: string, lines: string[], numbers: number[]): string {
  const out = [`=== CONTEXT: ${path} (${label}) ===`];
  let previous: number | undefined;
  for (const n of numbers) {
    if (previous !== undefined && n !== previous + 1) out.push(`${"".padStart(6)} ...`);
    out.push(`${String(n).padStart(6)} : ${lines[n - 1] ?? ""}`);
    previous = n;
  }
  return out.join("\n");
}

export function contextBlock(
  path: string,
  label: string,
  priority: number,
  lines: string[],
  numbers: number[],
): ContextBlock | undefined {
  if (!numbers.some((n) => lines[n - 1]?.trim())) return undefined;
  const text = renderContext(path, label, lines, numbers);
  return { path, label, priority, text, tokens: estimateTokens(text) };
}

// The lines a hunk changes, without the context the forge adds around them,
// which can reach into a neighbouring declaration. A removal has no new-file
// line of its own, so it counts as the lines either side of where it was.
export function changedSpan(hunk: Hunk): [number, number] {
  const touched: number[] = [];
  let newLine = hunk.newStart;
  let removing = false;
  for (const line of hunk.content.split("\n").slice(1)) {
    const marker = line[0];
    if (marker === "-") {
      if (!removing) touched.push(Math.max(1, newLine - 1), newLine);
      removing = true;
      continue;
    }
    if (marker === "\\") continue;
    removing = false;
    if (marker === "+") touched.push(newLine);
    newLine += 1;
  }
  if (!touched.length) return [hunk.newStart, hunk.newStart];
  return [Math.min(...touched), Math.max(...touched)];
}

// The enclosing scope of each hunk and the file's imports, minus what the
// hunks already show. Each merged scope is its own block, so a full pass
// loses the least it has to.
export function fileContextBlocks(file: ChangedFile, hunks: Hunk[], lines: string[]): ContextBlock[] {
  const shown = shownLines(hunks);
  const scopes = mergeRanges(hunks.map((hunk) => enclosingScope(lines, ...changedSpan(hunk))));
  const blocks = scopes.map((scope) =>
    contextBlock(file.path, "enclosing scope", CONTEXT_PRIORITY.scope, lines, numbersIn(scope, shown)),
  );
  const imports = importBlock(lines);
  if (imports) {
    const covered = new Set(shown);
    for (const scope of scopes) for (let n = scope.start; n <= scope.end; n++) covered.add(n);
    blocks.push(contextBlock(file.path, "imports", CONTEXT_PRIORITY.imports, lines, numbersIn(imports, covered)));
  }
  return blocks.filter((block): block is ContextBlock => !!block);
}

// Ranges rendered as a block, for definitions and call sites.
export function rangesBlock(
  path: string,
  label: string,
  priority: number,
  lines: string[],
  ranges: LineRange[],
): ContextBlock | undefined {
  const numbers = mergeRanges(ranges).flatMap((range) => numbersIn(range, new Set()));
  return contextBlock(path, label, priority, lines, numbers);
}
