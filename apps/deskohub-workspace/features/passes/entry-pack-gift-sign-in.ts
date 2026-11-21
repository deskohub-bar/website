const giftFragmentPrefix = "#gift=";
export const entryPackGiftSignInModeParam = "gift-sign-in";

export const entryPackGiftSignInSecretPattern =
  /^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/;

export const entryPackGiftSignInHash = (secret: string): string =>
  `${giftFragmentPrefix}${secret}`;

export const isEntryPackGiftSignInHash = (hash: string): boolean =>
  hash.startsWith(giftFragmentPrefix);

export function readEntryPackGiftSignInSecret(
  hash: string
): string | undefined {
  if (!isEntryPackGiftSignInHash(hash)) return undefined;
  const secret = hash.slice(giftFragmentPrefix.length);
  return entryPackGiftSignInSecretPattern.test(secret) ? secret : undefined;
}
