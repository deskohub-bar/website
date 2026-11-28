/** Keeps a response out of shared caches and keeps its URL off other origins. */
export const markPrivateResponse = <T extends Response>(
  response: T,
  referrerPolicy: "no-referrer" | "same-origin" = "no-referrer"
) => {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", referrerPolicy);
  return response;
};
