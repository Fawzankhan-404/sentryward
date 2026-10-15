import { posix } from "node:path";
import type { Hunk } from "../core/models.ts";
import type { LineRange } from "./fileContext.ts";

// Names the diff defines and calls, found by pattern rather than by parsing,
// and the relative imports that say where a called name is defined. Missing a
// name only costs context; a wrong one costs a few tokens of unrelated code.

const IDENT = "[A-Za-z_$][\\w$]*";
const DECLARATIONS = [
  new RegExp(`\\b(?:function\\*?|def|fn|class|interface|struct|enum|trait|type)\\s+(${IDENT})`),
  new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?(${IDENT})`),
  new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\(|${IDENT}\\s*=>)`),
  new RegExp(
    `^\\s*(?:(?:public|private|protected|static|async|override|readonly|export|default)\\s+)*(${IDENT})\\s*\\([^)]*\\)\\s*(?::[^{=]*)?\\{\\s*$`,
  ),
];
const CALL = new RegExp(`(?<![\\w$.])(${IDENT})\\s*\\(`, "g");
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "await", "new", "super", "import",
  "require", "else", "do", "try", "with", "yield", "delete", "void", "in", "of", "instanceof", "constructor",
  "this", "self", "print", "len", "str", "int", "elif", "except", "lambda", "not", "and", "or", "assert",
  "sizeof", "defer", "go", "func", "def", "fn", "match", "when", "async", "export", "default",
]);
// Shorter names match too much of any codebase to be worth a search.
const MIN_NAME_LENGTH = 3;

function wanted(name: string | undefined): name is string {
  return !!name && name.length >= MIN_NAME_LENGTH && !KEYWORDS.has(name);
}

export function declaredNames(line: string): string[] {
  return DECLARATIONS.map((pattern) => pattern.exec(line)?.[1]).filter(wanted);
}

export interface PartSymbols {
  // Declared on an added line or enclosing a hunk: changing them can break callers.
  defined: string[];
  // Called on an added line and not declared in the hunks themselves.
  called: string[];
}

export function partSymbols(hunks: Hunk[]): PartSymbols {
  const defined = new Set<string>();
  const called = new Set<string>();
  for (const hunk of hunks) {
    for (const name of declaredNames(hunk.header)) defined.add(name);
    for (const line of hunk.content.split("\n").slice(1)) {
      if (line[0] !== "+") continue;
      const text = line.slice(1);
      for (const name of declaredNames(text)) defined.add(name);
      for (const match of text.matchAll(CALL)) if (wanted(match[1])) called.add(match[1]);
    }
  }
  for (const name of defined) called.delete(name);
  return { defined: [...defined], called: [...called] };
}

export interface ImportBinding {
  module: string;
  // The name the module exports it under; "default" for a default import.
  exported: string;
}

function specifiers(list: string, separator: RegExp): [local: string, exported: string][] {
  return list
    .split(",")
    .map((spec) => spec.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((spec) => {
      const [exported, local] = spec.split(separator).map((part) => part.trim());
      return [local || exported!, exported!];
    });
}

// Local names bound by relative imports, the only ones that resolve to a file
// without knowing the build setup.
export function relativeImports(content: string): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const bind = (local: string, exported: string, module: string) => {
    if (new RegExp(`^${IDENT}$`).test(local) && !bindings.has(local)) bindings.set(local, { module, exported });
  };
  for (const match of content.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const clause = match[1]!;
    const module = match[2]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const [local, exported] of specifiers(braces[1]!, /\s+as\s+/)) bind(local, exported, module);
    const defaultName = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+\S+/, "").split(",")[0]!.trim();
    if (defaultName) bind(defaultName, "default", module);
  }
  for (const match of content.matchAll(
    /(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  )) {
    for (const [local, exported] of specifiers(match[1]!, /\s*:\s*/)) bind(local, exported, match[2]!);
  }
  for (const match of content.matchAll(/^from\s+(\.+[\w.]*)\s+import\s+\(?([^)\n#]+)/gm)) {
    for (const [local, exported] of specifiers(match[2]!, /\s+as\s+/)) bind(local, exported, match[1]!);
  }
  return bindings;
}

const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

// Paths a relative module may live at, most likely first. Empty when the
// module points outside the repository.
export function moduleCandidates(fromPath: string, module: string): string[] {
  const dir = posix.dirname(fromPath);
  let candidates: string[];
  if (/^\.\.?\//.test(module)) {
    const base = posix.join(dir, module);
    const extension = posix.extname(base);
    if (SCRIPT_EXTENSIONS.has(extension)) {
      // TypeScript imports name the emitted .js file.
      const stem = base.slice(0, -extension.length);
      candidates = extension === ".js" ? [base, `${stem}.ts`, `${stem}.tsx`] : [base];
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(fromPath)) {
      candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
    } else {
      candidates = [`${base}.js`, `${base}.jsx`, `${base}.ts`, `${base}/index.js`];
    }
  } else {
    // Python: one dot is the current package, each further dot its parent.
    const dots = /^\.+/.exec(module)![0].length;
    const rest = module.slice(dots).split(".").filter(Boolean).join("/");
    const base = posix.join(dir, ...Array<string>(dots - 1).fill(".."), rest);
    candidates = rest ? [`${base}.py`, `${base}/__init__.py`] : [`${base}/__init__.py`];
  }
  return candidates.map((path) => posix.normalize(path)).filter((path) => !path.startsWith(".."));
}

// The line declaring `name` (or the default export), if any.
export function declarationLine(lines: string[], exported: string): number | undefined {
  const index =
    exported === "default"
      ? lines.findIndex((line) => /^\s*export\s+default\b/.test(line))
      : lines.findIndex((line) => declaredNames(line).includes(exported));
  return index === -1 ? undefined : index + 1;
}

const CALL_SITE_BEFORE = 5;
const CALL_SITE_AFTER = 3;

// Windows around lines that call `name`, as a function or a method, skipping
// its declaration.
export function callSites(lines: string[], name: string, limit: number): LineRange[] {
  const pattern = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}\\s*\\(`);
  const ranges: LineRange[] = [];
  for (let n = 1; n <= lines.length && ranges.length < limit; n++) {
    const line = lines[n - 1]!;
    if (!pattern.test(line) || declaredNames(line).includes(name)) continue;
    ranges.push({ start: Math.max(1, n - CALL_SITE_BEFORE), end: Math.min(lines.length, n + CALL_SITE_AFTER) });
  }
  return ranges;
}
