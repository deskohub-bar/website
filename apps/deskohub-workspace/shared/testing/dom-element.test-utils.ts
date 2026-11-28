/**
 * Narrows a queried DOM node to the element type a test expects, failing the
 * test when the node is missing or of another type.
 */
export const elementOf = <T extends Element>(
  value: Element | null | undefined,
  type: abstract new (...args: never[]) => T
): T => {
  if (!(value instanceof type)) {
    throw new Error(
      `Expected ${type.name}, received ${value?.constructor.name ?? String(value)}`
    );
  }
  return value;
};
