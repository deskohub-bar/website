export const requireHydratedAccountLink = (element: Element): void => {
  const key = Object.keys(element).find((part) =>
    part.startsWith("__reactProps$")
  );
  const props: unknown =
    key === undefined ? undefined : Reflect.get(element, key);
  if (
    typeof props !== "object" ||
    props === null ||
    !("onClick" in props) ||
    typeof props.onClick !== "function"
  ) {
    throw new Error("fake link was not hydrated");
  }
};
