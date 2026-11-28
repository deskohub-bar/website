import { readFileSync } from "node:fs";
import { parse, parseForESLint } from "@typescript-eslint/parser";
import type { TSESTree } from "@typescript-eslint/types";
import { isString } from "effect/Predicate";

/**
 * Parsed-TypeScript structured checks for source contracts.
 *
 * Verdicts are computed from the real syntax tree of a tracked module, so
 * they are immune to formatting, whitespace, and comments: a commented-out
 * call never satisfies a presence check, and a reformatted call never fails
 * one. This replaces the retired source-as-string (substring/token) pattern.
 */

type AnyNode = TSESTree.Node;

export type ParsedSource = {
  readonly ast: TSESTree.Program;
  readonly source: string;
};

export const parseSource = (
  code: string,
  options: { readonly jsx?: boolean } = {}
): TSESTree.Program =>
  parse(code, {
    comment: false,
    ecmaFeatures: { jsx: options.jsx ?? false },
    range: true,
    sourceType: "module",
  });

export const parseTrackedSource = (filePath: string): ParsedSource => {
  const source = readFileSync(filePath, "utf8");
  return {
    ast: parseSource(source, { jsx: filePath.endsWith(".tsx") }),
    source,
  };
};

/**
 * The child keys of each syntax node type. Walking only these keeps the
 * parser's `tokens` array out of the tree: its entries also carry a string
 * `type` (`Identifier`, `Keyword`, `Punctuator`) but are not syntax nodes.
 * The parser hands its visitor keys out only with a parse, so an empty
 * source supplies them once.
 */
const { visitorKeys } = parseForESLint("", { range: true });

type NodeCandidate = { readonly type?: unknown };

/** What a visitor key holds: one child, a list of them, or nothing. */
type NodeChildren =
  | NodeCandidate
  | readonly (NodeCandidate | null)[]
  | null
  | undefined;

/** A child object is a syntax node when it carries a string `type`. */
const isNode = (value: NodeCandidate): value is AnyNode => isString(value.type);

/** Every syntax node in the tree, parents before children. */
export const nodesOf = (root: AnyNode): readonly AnyNode[] => {
  const collected: AnyNode[] = [];
  const visit = (node: AnyNode): void => {
    collected.push(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const children: NodeChildren = Reflect.get(node, key);
      for (const child of [children].flat()) {
        if (child !== null && child !== undefined && isNode(child)) {
          visit(child);
        }
      }
    }
  };
  visit(root);
  return collected;
};

type RangedNode = AnyNode & { readonly range: [number, number] };

const hasRange = (node: AnyNode): node is RangedNode =>
  Array.isArray(node.range);

/** True when `inner` sits lexically inside `outer` (range containment). */
export const containsNode = (outer: AnyNode, inner: AnyNode): boolean =>
  hasRange(outer) &&
  hasRange(inner) &&
  outer.range[0] <= inner.range[0] &&
  inner.range[1] <= outer.range[1];

/** Call expressions whose callee resolves to the bare identifier `name`. */
export const callsNamed = (
  root: AnyNode,
  name: string
): readonly TSESTree.CallExpression[] =>
  nodesOf(root).flatMap((node) =>
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === name
      ? [node]
      : []
  );

/** Call expressions invoked as `<anything>.<property>()` for `property`. */
export const methodCallsNamed = (
  root: AnyNode,
  property: string
): readonly TSESTree.CallExpression[] =>
  nodesOf(root).flatMap((node) =>
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === property
      ? [node]
      : []
  );

/** Every distinct identifier or member-property name referenced in the tree. */
export const identifierNames = (root: AnyNode): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const node of nodesOf(root)) {
    if (node.type === "Identifier" && isString(node.name)) {
      names.add(node.name);
    }
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.property.type === "Identifier" &&
      isString(node.property.name)
    ) {
      names.add(node.property.name);
    }
  }
  return names;
};

/** Values of string literals in the tree, with their nodes. */
export const stringLiterals = (
  root: AnyNode
): readonly { readonly node: TSESTree.Literal; readonly value: string }[] =>
  nodesOf(root).flatMap((node) => {
    if (node.type !== "Literal") return [];
    return isString(node.value) ? [{ node, value: node.value }] : [];
  });

/**
 * The initializer node of a top-level (possibly exported) `const <name> =
 * <init>` declaration, or undefined when the module does not declare it.
 */
export const topLevelConstInitializer = (
  root: TSESTree.Program,
  name: string
): AnyNode | undefined => {
  for (const statement of root.body) {
    if (
      statement.type !== "ExportNamedDeclaration" &&
      statement.type !== "VariableDeclaration"
    ) {
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (
        declarator.id.type === "Identifier" &&
        declarator.id.name === name &&
        declarator.init
      ) {
        return declarator.init;
      }
    }
  }
  return undefined;
};
