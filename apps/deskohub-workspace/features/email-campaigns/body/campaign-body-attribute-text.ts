/**
 * Parses a text attribute from the HTML attribute `name`, as written.
 * TipTap's default parsing reads digit-only text as a number, and a long run
 * of digits as Infinity, which the body format can't hold.
 */
export const htmlAttributeText = (name: string) => (element: HTMLElement) =>
  element.getAttribute(name);
