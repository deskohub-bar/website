/**
 * Whether the page already runs posthog-js. Its snippet build assigns
 * `window.posthog` in `init_from_snippet`. App analytics stays off to avoid
 * double capture on the same page.
 */
export const detectOtherPostHogSdk = (page: object): boolean => {
  const candidate = (page as { readonly posthog?: unknown }).posthog;
  return typeof candidate === "object" && candidate !== null;
};
