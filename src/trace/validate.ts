import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { Trace } from "./types.js";

// ajv and ajv-formats ship CommonJS; createRequire loads them with their real (default-export) types.
const require = createRequire(import.meta.url);
const Ajv2020 = (require("ajv/dist/2020") as { default: typeof import("ajv/dist/2020.js").default }).default;
const addFormats = (require("ajv-formats") as { default: typeof import("ajv-formats").default }).default;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TRACE_SCHEMA_PATH = join(REPO_ROOT, "trace.schema.json");

export function loadTraceSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(TRACE_SCHEMA_PATH, "utf8")) as Record<string, unknown>;
}

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const v = ajv.compile(loadTraceSchema());
  compiled = v;
  return v;
}

export interface TraceValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a trace document against trace.schema.json. Shape only; run-validity checks are M6. */
export function validateTrace(doc: unknown): TraceValidationResult {
  const v = validator();
  const valid = v(doc) as boolean;
  const errors = (v.errors ?? []).map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { valid, errors };
}


