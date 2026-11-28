import { type Mock, spyOn } from "bun:test";

/**
 * Answers every `fetch` with `respond` until the next stub or the spy's
 * restore, and returns the spy with only this stub's calls. The installed spy
 * keeps the real `preconnect`, which Bun's `fetch` carries.
 */
export const stubFetch = (
  respond: (...args: Parameters<typeof fetch>) => Promise<Response>
): Mock<typeof fetch> => {
  const { preconnect } = globalThis.fetch;
  const fetchSpy = Object.assign(spyOn(globalThis, "fetch"), { preconnect });
  fetchSpy.mockClear();
  return fetchSpy.mockImplementation(Object.assign(respond, { preconnect }));
};
