import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * The React element a route component returned, typed with the props the
 * test reads. Fails the test when the node is not an element.
 */
export const requireElement = <Props>(node: ReactNode): ReactElement<Props> => {
  assert(isValidElement<Props>(node), "Expected a React element");
  return node;
};

/**
 * Renders one level of a server component element by calling its function
 * component with the element's props, as React would on the server.
 */
export const renderComponentElement = async (
  element: ReactElement
): Promise<ReactNode> => {
  const { type, props } = element;
  assert(type instanceof Function, "Expected a function component element");
  return await Reflect.apply(type, undefined, [props]);
};
