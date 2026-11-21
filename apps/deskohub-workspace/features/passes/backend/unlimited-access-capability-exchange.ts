import { setLocaleCookie } from "@deskohub/i18n/next";
import { Effect, Schema } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import type { Locale } from "@/features/i18n";
import { localeCookieName } from "@/features/i18n/routing";
import { orderIdSchema } from "@/features/order";
import { parseCanonicalReservationAccessUrl } from "@/features/reservation/backend/reservation-access-cookie";
import { runWorkspaceEffect } from "@/shared/backend/workspace-effect";
import { markPrivateResponse } from "@/shared/utils/private-response";
import { getUnlimitedAccessPath } from "../routes";
import { unlimitedAccessTokenQueryParam } from "../unlimited-access";
import { exchangeUnlimitedAccessToken } from "./unlimited-access-capability";

const reject = () =>
  markPrivateResponse(new NextResponse(null, { status: 404 }));

export const exchangeUnlimitedAccessCapability = (
  request: NextRequest,
  locale: Locale
) => {
  const url = request.nextUrl.clone();
  const [token, duplicate] = url.searchParams.getAll(
    unlimitedAccessTokenQueryParam
  );
  if (!token || duplicate !== undefined) return reject();

  url.searchParams.delete(unlimitedAccessTokenQueryParam);
  const rawOrderId = parseCanonicalReservationAccessUrl(
    `${url.pathname}${url.search}`,
    locale
  );

  return Effect.gen(function* () {
    const orderId =
      yield* Schema.decodeUnknownEffect(orderIdSchema)(rawOrderId);
    const cookie = yield* exchangeUnlimitedAccessToken({
      token,
      orderId,
      locale,
    });
    const response = NextResponse.redirect(
      new URL(getUnlimitedAccessPath(locale, orderId), request.url)
    );
    response.cookies.set(cookie);
    setLocaleCookie(response, localeCookieName, locale);
    return markPrivateResponse(response);
  }).pipe(
    Effect.orElseSucceed(reject),
    runWorkspaceEffect("passes.access.exchange", { boundary: "route" })
  );
};
