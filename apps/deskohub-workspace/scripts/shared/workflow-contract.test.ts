import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  evaluateWorkflowValue,
  parseCompositeAction,
  parseWorkflow,
  workflowExpressionBoolean,
  workflowExpressionString,
} from "./workflow-contract";

const context = {
  contexts: ["github", "inputs"],
  values: new Map([
    ["github.event_name", workflowExpressionString("workflow_dispatch")],
    ["inputs.enabled", workflowExpressionBoolean(true)],
    ["inputs.disabled", workflowExpressionBoolean(false)],
    ["secrets.example", workflowExpressionString("unmodeled")],
  ]),
};

const evaluate = (expression: string) =>
  evaluateWorkflowValue(`\${{ ${expression} }}`, context);

describe("workflow expression evaluation", () => {
  test("returns operands from && and || as GitHub does", () => {
    expect(evaluate("'a' && 'b'")).toBe("b");
    expect(evaluate("'' && 'b'")).toBe("");
    expect(evaluate("'' || 'b'")).toBe("b");
    expect(evaluate("inputs.disabled && 'set'")).toBe("false");
  });

  test("binds == tighter than && and && tighter than ||", () => {
    expect(evaluate("'x' || '' && 'y'")).toBe("x");
    expect(evaluate("'a' == 'b' || 'c' == 'c' && 'd'")).toBe("d");
  });

  test("negates == with != at the same precedence", () => {
    expect(evaluate("'a' != 'b' && 'x'")).toBe("x");
    expect(evaluate("github.event_name != 'WORKFLOW_DISPATCH' || 'y'")).toBe(
      "y"
    );
    expect(() => evaluate("inputs.enabled != 'true'")).toThrow();
  });

  test("treats the string 'false' as truthy and the boolean false as falsy", () => {
    expect(evaluate("'false' && 'set'")).toBe("set");
    expect(evaluate("inputs.disabled || 'unset'")).toBe("unset");
  });

  test("hands the step booleans as text and a missing input as empty", () => {
    expect(evaluate("inputs.enabled")).toBe("true");
    expect(evaluate("inputs.missing")).toBe("");
  });

  test("compares strings case-insensitively and unescapes quotes", () => {
    expect(evaluate("github.event_name == 'WORKFLOW_DISPATCH'")).toBe("true");
    expect(evaluate("'it''s set'")).toBe("it's set");
  });

  test("rejects expressions outside the modeled subset", () => {
    expect(() => evaluate("always()")).toThrow();
    expect(() => evaluate("secrets.example")).toThrow();
    expect(() => evaluate("'set' || secrets.example")).toThrow();
    expect(() => evaluate("inputs.enabled == 'true'")).toThrow();
    expect(() => evaluate("inputs.enabled &&")).toThrow();
    expect(() => evaluate("inputs.enabled 'set'")).toThrow();
    expect(() => evaluateWorkflowValue("true", context)).toThrow();
    expect(() =>
      evaluateWorkflowValue(`prefix-\${{ inputs.enabled }}`, context)
    ).toThrow();
  });
});

const githubDirectory = resolve(import.meta.dir, "../../../../.github");
const parsedYaml = (path: string): unknown =>
  Bun.YAML.parse(readFileSync(path, "utf8"));

describe("tracked workflow parsing", () => {
  test("returns every tracked workflow whole, undeclared keys included", () => {
    const directory = join(githubDirectory, "workflows");
    const paths = readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(directory, name));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(parseWorkflow(path)).toEqual(parsedYaml(path));
    }
  });

  test("returns every tracked composite action whole", () => {
    const directory = join(githubDirectory, "actions");
    const paths = readdirSync(directory)
      .map((name) => join(directory, name, "action.yml"))
      .filter((path) => existsSync(path));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(parseCompositeAction(path)).toEqual(parsedYaml(path));
    }
  });
});
