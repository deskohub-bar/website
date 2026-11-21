import {
  entryPackGiftSignInModeParam,
  isEntryPackGiftSignInHash,
  readEntryPackGiftSignInSecret,
} from "./entry-pack-gift-sign-in";

let giftSignInDocument = false;
let startupSecret: string | null | undefined;

export const isEntryPackGiftSignInDocument = () => giftSignInDocument;

/** Undefined means there is no gift fragment. Null means it could not be opened. */
export function removeEntryPackGiftSignInFragment(): string | null | undefined {
  const { hash, pathname, search } = window.location;
  if (!isEntryPackGiftSignInHash(hash)) return undefined;

  try {
    window.history.replaceState(window.history.state, "", pathname + search);
  } catch {
    return null;
  }
  return readEntryPackGiftSignInSecret(hash) ?? null;
}

/** Captures an invitation before the document starts any tracking scripts. */
export function prepareEntryPackGiftSignInDocument() {
  const { pathname, search, hash } = window.location;
  if (!pathname.endsWith("/auth/sign-in")) return;
  giftSignInDocument =
    isEntryPackGiftSignInHash(hash) ||
    new URLSearchParams(search).get(entryPackGiftSignInModeParam) === "1";
  startupSecret = removeEntryPackGiftSignInFragment();
}

export function takeEntryPackGiftSignInSecret() {
  const secret = removeEntryPackGiftSignInFragment();
  const initial = startupSecret;
  startupSecret = undefined;
  return secret === undefined ? initial : secret;
}
