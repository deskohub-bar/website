/**
 * The label of a code a renderer's label map knows, or `undefined` for a
 * code this binary doesn't know, so the caller can fall back to the code.
 */
export const knownCodeLabel = <Code extends string>(
  labels: Readonly<Record<Code, string>>,
  code: string
): string | undefined =>
  Object.hasOwn(labels, code) ? labels[code as Code] : undefined;
