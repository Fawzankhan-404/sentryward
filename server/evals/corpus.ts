import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { configOverrideSchema, type ConfigOverride } from "../src/review/config/schema.ts";
import type { ChangeSet } from "../src/review/core/models.ts";
import { categorySchema, type Category } from "../src/review/core/severity.ts";
import { parseUnifiedDiff } from "../src/review/diff/parse.ts";

export const CASES_DIR = join(import.meta.dirname, "cases");

const rangeSchema = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([start, end]) => start <= end, "start must not be after end");

const expectedSchema = z.strictObject({
  file: z.string().min(1),
  lines: rangeSchema,
  // A list when more than one reading is fair, e.g. a crash that is both a
  // bug and a reliability problem.
  category: z.union([categorySchema, z.array(categorySchema).min(1)]),
  description: z.string().min(1),
});

const trapSchema = z.strictObject({
  file: z.string().min(1),
  lines: rangeSchema,
  note: z.string().min(1),
});

const caseFileSchema = z.strictObject({
  title: z.string().min(1),
  description: z.string().default(""),
  language: z.string().min(1),
  // Empty means the change has nothing worth reporting.
  expected: z.array(expectedSchema).default([]),
  traps: z.array(trapSchema).default([]),
  // camelCase, like the dashboard layers, applied as the trigger layer.
  config: configOverrideSchema.default({}),
});

export interface Expected {
  file: string;
  startLine: number;
  endLine: number;
  categories: Category[];
  description: string;
}

export interface Trap {
  file: string;
  startLine: number;
  endLine: number;
  note: string;
}

export interface EvalCase {
  id: string;
  dir: string;
  title: string;
  language: string;
  changeSet: ChangeSet;
  expected: Expected[];
  traps: Trap[];
  config: ConfigOverride;
}

export function loadCase(dir: string, id: string): EvalCase {
  const parsed = caseFileSchema.safeParse(YAML.parse(readFileSync(join(dir, "case.yaml"), "utf8")));
  if (!parsed.success) {
    throw new Error(`${id}/case.yaml: ${z.prettifyError(parsed.error)}`);
  }
  const spec = parsed.data;
  const files = parseUnifiedDiff(readFileSync(join(dir, "diff.patch"), "utf8"));
  if (files.length === 0) throw new Error(`${id}/diff.patch has no files`);

  return {
    id,
    dir,
    title: spec.title,
    language: spec.language,
    // A synthetic ref: nothing is published, but the result and fingerprints
    // need one.
    changeSet: {
      forgeRef: {
        provider: "github",
        host: "github.com",
        project: "sentryward/evals",
        number: 1,
        baseSha: "base",
        startSha: "base",
        headSha: "head",
      },
      title: spec.title,
      description: spec.description,
      baseRef: "main",
      headRef: id,
      isDraft: false,
      files,
    },
    expected: spec.expected.map(({ file, lines, category, description }) => ({
      file,
      startLine: lines[0],
      endLine: lines[1],
      categories: Array.isArray(category) ? category : [category],
      description,
    })),
    traps: spec.traps.map(({ file, lines, note }) => ({ file, startLine: lines[0], endLine: lines[1], note })),
    config: spec.config,
  };
}

// Every directory under cases/ with a case.yaml, in name order so reports line
// up between runs. `only` narrows it to those ids and rejects unknown ones.
export function loadCorpus(only?: string[], root = CASES_DIR): EvalCase[] {
  const ids = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "case.yaml")))
    .map((entry) => entry.name)
    .sort();
  const unknown = (only ?? []).filter((id) => !ids.includes(id));
  if (unknown.length > 0) throw new Error(`Unknown case(s): ${unknown.join(", ")}`);
  return ids.filter((id) => !only || only.includes(id)).map((id) => loadCase(join(root, id), id));
}
