import { readFileSync } from "node:fs";
import { Schema } from "effect";

/**
 * Parses a tracked GitHub Actions workflow into typed objects so tests can
 * assert on workflow structure (jobs, steps, scripts, needs, permissions)
 * instead of pinned YAML substrings.
 */

/** A step `env` or `with` value; YAML may write it unquoted (`fetch-depth: 0`). */
export type WorkflowStepValue = string | number | boolean;

export interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly id?: string;
  readonly if?: string;
  readonly "working-directory"?: string;
  readonly "continue-on-error"?: boolean;
  readonly "timeout-minutes"?: number;
  readonly env?: Record<string, WorkflowStepValue>;
  readonly with?: Record<string, WorkflowStepValue>;
  readonly outputs?: Record<string, string>;
}

/** Cache access a job's token gets (`cache-mode`). */
type WorkflowCacheMode = "none" | "read" | "write" | "write-only";

interface WorkflowJob {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly concurrency?: {
    readonly group: string;
    readonly "cancel-in-progress"?: boolean | string;
  };
  readonly outputs?: Record<string, string>;
  readonly "cache-mode"?: WorkflowCacheMode;
  readonly "runs-on"?: string;
  readonly steps?: readonly WorkflowStep[];
  /** Minutes, or an expression such as `${{ inputs.mode == ... }}`. */
  readonly "timeout-minutes"?: number | string;
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly services?: Readonly<Record<string, WorkflowService>>;
}

interface WorkflowService {
  readonly image: string;
  readonly env?: Record<string, string>;
  readonly ports?: readonly string[];
  readonly options?: string;
}

interface WorkflowDispatchInput {
  readonly default?: boolean | string;
  readonly description?: string;
  readonly required?: boolean;
  readonly type?: string;
}

export interface WorkflowDoc {
  readonly "cache-mode"?: WorkflowCacheMode;
  readonly concurrency?: WorkflowJob["concurrency"];
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly on?: Readonly<{
    readonly schedule?: readonly { readonly cron: string }[];
    readonly workflow_dispatch?: null | {
      readonly inputs?: Readonly<Record<string, WorkflowDispatchInput>>;
    };
  }>;
  readonly permissions?: Record<string, string>;
}

/** A tracked composite action (`.github/actions/<name>/action.yml`). */
export interface CompositeActionDoc {
  readonly inputs?: Readonly<
    Record<string, { readonly required?: boolean; readonly default?: string }>
  >;
  readonly outputs?: Readonly<Record<string, { readonly value: string }>>;
  readonly runs: {
    readonly using: string;
    readonly steps: readonly WorkflowStep[];
  };
}

/*
 * Shape checks for the parsed YAML. They only validate: a document that
 * passes is returned as parsed, keys these contracts leave undeclared
 * included, so tests still read the whole document. Each schema shares its
 * interface's name; the compiler checks that what a schema validates fits
 * the interface the parser returns.
 */

const StringRecord = Schema.Record(Schema.String, Schema.String);

const StepValueRecord = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
);

const WorkflowStep = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  "working-directory": Schema.optionalKey(Schema.String),
  "continue-on-error": Schema.optionalKey(Schema.Boolean),
  "timeout-minutes": Schema.optionalKey(Schema.Number),
  env: Schema.optionalKey(StepValueRecord),
  with: Schema.optionalKey(StepValueRecord),
  outputs: Schema.optionalKey(StringRecord),
});

const WorkflowCacheMode = Schema.Literals([
  "none",
  "read",
  "write",
  "write-only",
]);

const WorkflowConcurrency = Schema.Struct({
  group: Schema.String,
  "cancel-in-progress": Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.String])
  ),
});

const WorkflowJob = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String)])
  ),
  concurrency: Schema.optionalKey(WorkflowConcurrency),
  outputs: Schema.optionalKey(StringRecord),
  "cache-mode": Schema.optionalKey(WorkflowCacheMode),
  "runs-on": Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Array(WorkflowStep)),
  "timeout-minutes": Schema.optionalKey(
    Schema.Union([Schema.Number, Schema.String])
  ),
  permissions: Schema.optionalKey(StringRecord),
  env: Schema.optionalKey(StringRecord),
  services: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        image: Schema.String,
        env: Schema.optionalKey(StringRecord),
        ports: Schema.optionalKey(Schema.Array(Schema.String)),
        options: Schema.optionalKey(Schema.String),
      })
    )
  ),
});

const WorkflowDoc = Schema.Struct({
  "cache-mode": Schema.optionalKey(WorkflowCacheMode),
  concurrency: Schema.optionalKey(WorkflowConcurrency),
  jobs: Schema.Record(Schema.String, WorkflowJob),
  on: Schema.optionalKey(
    Schema.Struct({
      schedule: Schema.optionalKey(
        Schema.Array(Schema.Struct({ cron: Schema.String }))
      ),
      workflow_dispatch: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            inputs: Schema.optionalKey(
              Schema.Record(
                Schema.String,
                Schema.Struct({
                  default: Schema.optionalKey(
                    Schema.Union([Schema.Boolean, Schema.String])
                  ),
                  description: Schema.optionalKey(Schema.String),
                  required: Schema.optionalKey(Schema.Boolean),
                  type: Schema.optionalKey(Schema.String),
                })
              )
            ),
          })
        )
      ),
    })
  ),
  permissions: Schema.optionalKey(StringRecord),
});

const CompositeActionDoc = Schema.Struct({
  inputs: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        required: Schema.optionalKey(Schema.Boolean),
        default: Schema.optionalKey(Schema.String),
      })
    )
  ),
  outputs: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ value: Schema.String }))
  ),
  runs: Schema.Struct({
    using: Schema.String,
    steps: Schema.Array(WorkflowStep),
  }),
});

const readYaml = (path: string): unknown =>
  Bun.YAML.parse(readFileSync(path, "utf8"));

export const parseWorkflow = (path: string): WorkflowDoc => {
  const document = readYaml(path);
  Schema.asserts(WorkflowDoc, document);
  return document;
};

export const parseCompositeAction = (path: string): CompositeActionDoc => {
  const document = readYaml(path);
  Schema.asserts(CompositeActionDoc, document);
  return document;
};

export const workflowJobs = (doc: WorkflowDoc): readonly string[] =>
  Object.keys(doc.jobs);

export const workflowSteps = (
  doc: WorkflowDoc,
  jobId: string
): readonly WorkflowStep[] => doc.jobs[jobId]?.steps ?? [];

export const workflowStepNames = (doc: WorkflowDoc): readonly string[] =>
  Object.values(doc.jobs).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.name ?? "")
      .filter((name) => name.length > 0)
  );

export const workflowStepRuns = (doc: WorkflowDoc): readonly string[] =>
  Object.values(doc.jobs).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.run ?? "")
      .filter((run) => run.length > 0)
  );

export const findStepByName = (
  doc: WorkflowDoc,
  name: string
): WorkflowStep | undefined =>
  Object.values(doc.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.name === name);

type WorkflowExpressionValue =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string };

export interface WorkflowExpressionContext {
  /**
   * Contexts the caller models, such as `inputs`. A missing property of one
   * reads as null, as on GitHub; a path under any other context throws.
   */
  readonly contexts: readonly string[];
  /** Values keyed by their full path, such as `inputs.sha`. */
  readonly values: ReadonlyMap<string, WorkflowExpressionValue>;
}

type WorkflowExpressionToken =
  | { readonly kind: "operator"; readonly value: string }
  | { readonly kind: "path"; readonly value: string }
  | { readonly kind: "string"; readonly value: string };

export const workflowExpressionString = (
  value: string
): WorkflowExpressionValue => ({ kind: "string", value });

export const workflowExpressionBoolean = (
  value: boolean
): WorkflowExpressionValue => ({ kind: "boolean", value });

const expressionToken =
  /\s*(?:(==|!=|&&|\|\|)|'((?:[^']|'')*)'|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*))/y;

const tokenizeExpression = (
  source: string
): readonly WorkflowExpressionToken[] => {
  const tokens: WorkflowExpressionToken[] = [];
  expressionToken.lastIndex = 0;
  while (source.slice(expressionToken.lastIndex).trim() !== "") {
    const match = expressionToken.exec(source);
    if (match === null) {
      throw new Error(`unsupported workflow expression syntax: ${source}`);
    }
    const [, operator, text, path] = match;
    if (operator !== undefined) {
      tokens.push({ kind: "operator", value: operator });
    } else if (text !== undefined) {
      tokens.push({ kind: "string", value: text.replaceAll("''", "'") });
    } else if (path !== undefined) {
      tokens.push({ kind: "path", value: path });
    } else {
      throw new Error(`unsupported workflow expression syntax: ${source}`);
    }
  }
  return tokens;
};

const expressionTruthy = (value: WorkflowExpressionValue) =>
  value.kind === "boolean"
    ? value.value
    : value.kind === "string" && value.value !== "";

const expressionEqual = (
  left: WorkflowExpressionValue,
  right: WorkflowExpressionValue
) => {
  if (left.kind === "string" && right.kind === "string") {
    return left.value.toLowerCase() === right.value.toLowerCase();
  }
  if (left.kind === "boolean" && right.kind === "boolean") {
    return left.value === right.value;
  }
  if (left.kind === "null" && right.kind === "null") {
    return true;
  }
  throw new Error("unsupported mixed-type workflow expression comparison");
};

const resolveExpressionPath = (
  context: WorkflowExpressionContext,
  path: string
): WorkflowExpressionValue => {
  if (!context.contexts.some((root) => path.startsWith(`${root}.`))) {
    throw new Error(`unsupported workflow expression context: ${path}`);
  }
  return context.values.get(path) ?? { kind: "null" };
};

// Evaluates the GitHub Actions expression subset of context paths, string
// literals, ==, !=, && and ||, with GitHub's precedence and operand-returning &&
// and ||. It evaluates both operands where GitHub short-circuits, and anything
// outside the subset throws, so an expression it cannot model fails instead
// of misevaluating.
const evaluateExpression = (
  source: string,
  context: WorkflowExpressionContext
): WorkflowExpressionValue => {
  const tokens = tokenizeExpression(source);
  let position = 0;
  const accept = (operator: string) => {
    const token = tokens[position];
    if (token?.kind !== "operator" || token.value !== operator) {
      return false;
    }
    position += 1;
    return true;
  };
  const operand = (): WorkflowExpressionValue => {
    const token = tokens[position];
    position += 1;
    if (token?.kind === "string") {
      return workflowExpressionString(token.value);
    }
    if (token?.kind === "path") {
      return resolveExpressionPath(context, token.value);
    }
    throw new Error(`unsupported workflow expression: ${source}`);
  };
  const equality = (): WorkflowExpressionValue => {
    const left = operand();
    if (accept("==")) {
      return workflowExpressionBoolean(expressionEqual(left, operand()));
    }
    if (accept("!=")) {
      return workflowExpressionBoolean(!expressionEqual(left, operand()));
    }
    return left;
  };
  const and = (): WorkflowExpressionValue => {
    let value = equality();
    while (accept("&&")) {
      const right = equality();
      value = expressionTruthy(value) ? right : value;
    }
    return value;
  };
  const or = (): WorkflowExpressionValue => {
    let value = and();
    while (accept("||")) {
      const right = and();
      value = expressionTruthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (position !== tokens.length) {
    throw new Error(`unsupported workflow expression: ${source}`);
  }
  return value;
};

/**
 * Resolves a workflow value that is a single `${{ }}` expression to the
 * string GitHub hands the step, so tests can assert what a workflow does for
 * a given event instead of pinning its expression text.
 */
export const evaluateWorkflowValue = (
  value: string,
  context: WorkflowExpressionContext
): string => {
  const expression = /^\$\{\{(.*)\}\}$/s.exec(value.trim());
  if (expression === null) {
    throw new Error(`expected a single workflow expression: ${value}`);
  }
  const result = evaluateExpression(expression[1] ?? "", context);
  if (result.kind === "null") {
    return "";
  }
  return String(result.value);
};
