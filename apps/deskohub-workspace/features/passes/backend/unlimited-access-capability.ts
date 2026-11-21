import { createHash, createHmac } from "node:crypto";
import { Data, Effect, Schema } from "effect";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { appendVercelPreviewProtectionBypass } from "@/features/checkout/backend/checkout/vercel-preview-protection-bypass";
import { type Locale, locales } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  getReservationAccessTokenSecret,
  type ReservationAccessTokenOptions,
} from "@/features/reservation/backend/reservation-access-token";
import { makeSignedClaims } from "@/shared/backend/signed-claims";
import { getUnlimitedAccessPath } from "../routes";
import { unlimitedAccessTokenQueryParam } from "../unlimited-access";

const linkPurpose = "unlimited-pass-access";
const cookiePurpose = "unlimited-pass-access-cookie";
const binding = Schema.Struct({
  orderId: orderIdSchema,
  holder: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
const linkClaims = makeSignedClaims({
  purpose: linkPurpose,
  schema: Schema.Struct({
    purpose: Schema.Literal(linkPurpose),
    ...binding.fields,
    locale: Schema.Literals(locales),
  }),
});
const cookieClaims = makeSignedClaims({
  purpose: cookiePurpose,
  schema: Schema.Struct({
    purpose: Schema.Literal(cookiePurpose),
    ...binding.fields,
    expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});

const capabilityValue = Schema.NonEmptyString.check(Schema.isMaxLength(4096));
const cookieMaxAge = 24 * 60 * 60;

class UnlimitedAccessCapabilityInvalid extends Data.TaggedError(
  "UnlimitedAccessCapabilityInvalid"
)<{ readonly message: string }> {}

const invalidCapability = () =>
  new UnlimitedAccessCapabilityInvalid({
    message: "Unlimited pass access capability is invalid.",
  });

// Signed claims are readable. Bind the holder without putting an account ID
// or a cross-pass account identifier in the link or cookie.
const holderBinding = (
  secret: Buffer,
  orderId: OrderId,
  holderAccountId: CustomerAccountId
) =>
  createHmac("sha256", secret)
    .update(JSON.stringify(["unlimited-pass-holder", orderId, holderAccountId]))
    .digest("base64url");

const now = (options: ReservationAccessTokenOptions) =>
  options.now?.() ?? Date.now();

const keys = (secret: Buffer) => Effect.succeed([secret] as const);

export const createUnlimitedAccessUrl = Effect.fn("passes.access.createUrl")(
  function* (
    input: {
      readonly orderId: OrderId;
      readonly holderAccountId: CustomerAccountId;
      readonly locale: Locale;
      readonly origin: URL;
    },
    options: ReservationAccessTokenOptions = {}
  ) {
    const { orderId, holderAccountId, locale, origin } = input;
    const secret = yield* getReservationAccessTokenSecret(options);
    // Confirmation retries reuse the same idempotency key and email body.
    const token = yield* linkClaims.sign(
      {
        purpose: linkPurpose,
        orderId,
        holder: holderBinding(secret, orderId, holderAccountId),
        locale,
      },
      [secret]
    );
    const url = new URL(getUnlimitedAccessPath(locale, orderId), origin);
    url.searchParams.set(unlimitedAccessTokenQueryParam, token);
    appendVercelPreviewProtectionBypass(url, { setBypassCookie: true });
    return url.href;
  }
);

export const getUnlimitedAccessCookieName = (orderId: OrderId) =>
  `__Host-deskohub-unlimited-access-${createHash("sha256")
    .update(orderId)
    .digest("base64url")}`;

export const exchangeUnlimitedAccessToken = Effect.fn(
  "passes.access.exchangeToken"
)(function* (
  input: {
    readonly token: string;
    readonly orderId: OrderId;
    readonly locale: Locale;
  },
  options: ReservationAccessTokenOptions = {}
) {
  const token = yield* Schema.decodeEffect(capabilityValue)(input.token);
  const secret = yield* getReservationAccessTokenSecret(options);
  const claims = yield* linkClaims.open(token, keys(secret));
  if (claims.orderId !== input.orderId || claims.locale !== input.locale) {
    return yield* invalidCapability();
  }

  const value = yield* cookieClaims.sign(
    {
      purpose: cookiePurpose,
      orderId: claims.orderId,
      holder: claims.holder,
      expiresAt: now(options) + cookieMaxAge * 1000,
    },
    [secret]
  );
  return {
    name: getUnlimitedAccessCookieName(claims.orderId),
    value,
    httpOnly: true,
    maxAge: cookieMaxAge,
    path: "/",
    sameSite: "lax",
    secure: true,
  } as const;
});

export const openUnlimitedAccessCookie = Effect.fn("passes.access.openCookie")(
  function* (
    orderId: OrderId,
    cookie: string,
    options: ReservationAccessTokenOptions = {}
  ) {
    const value = yield* Schema.decodeEffect(capabilityValue)(cookie);
    const secret = yield* getReservationAccessTokenSecret(options);
    const claims = yield* cookieClaims.open(value, keys(secret));
    if (claims.orderId !== orderId || claims.expiresAt <= now(options)) {
      return yield* invalidCapability();
    }
    return (holderAccountId: CustomerAccountId) =>
      claims.expiresAt > now(options) &&
      claims.holder === holderBinding(secret, orderId, holderAccountId);
  }
);
