import { Effect, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  defineWorkspaceRoute,
  WorkspaceRouteFailure,
} from "@/shared/backend/workspace-route";
import {
  authorizeMockPaymentSession,
  decideMockPaymentSession,
  isMockPaymentCapability,
  type MockPaymentCapability,
  mockHostedPaymentPath,
} from "./mock-payment-provider";
import { isMockPaymentEnabled } from "./payment-provider-selection";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

const notFound = () =>
  new Response(null, { status: 404, headers: privateHeaders });

const renderHostedPayment = ({ paymentId, token }: MockPaymentCapability) =>
  new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Test payment</title>
  </head>
  <body>
    <main>
      <h1>Test payment</h1>
      <form action="${mockHostedPaymentPath}" method="post">
        <input type="hidden" name="paymentId" value="${paymentId}">
        <input type="hidden" name="token" value="${token}">
        <button type="submit" name="decision" value="approved">Approve test payment</button>
        <button type="submit" name="decision" value="declined">Decline test payment</button>
      </form>
    </main>
  </body>
</html>`,
    {
      headers: {
        ...privateHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      },
    }
  );

export const readMockHostedPaymentPage = Effect.fn(
  "mockPayment.readHostedPage"
)(function* (request: Request) {
  const { searchParams } = new URL(request.url);
  const capability = {
    paymentId: searchParams.get("paymentId"),
    token: searchParams.get("token"),
  };

  if (!isMockPaymentCapability(capability)) return notFound();
  if (!(yield* authorizeMockPaymentSession(capability))) return notFound();
  return renderHostedPayment(capability);
});

export const submitMockHostedPaymentDecision = Effect.fn(
  "mockPayment.submitDecision"
)(function* (request: Request) {
  const form = yield* Effect.tryPromise(() => request.formData()).pipe(
    Effect.option
  );
  if (Option.isNone(form)) return notFound();

  const capability = {
    paymentId: form.value.get("paymentId"),
    token: form.value.get("token"),
  };
  const decision = form.value.get("decision");
  if (!isMockPaymentCapability(capability)) return notFound();
  if (decision !== "approved" && decision !== "declined") return notFound();

  const returnUrl = yield* decideMockPaymentSession(capability, decision);
  if (!returnUrl) return notFound();

  return new Response(null, {
    status: 303,
    headers: { ...privateHeaders, Location: returnUrl },
  });
});

const handleMockHostedPaymentRoute = defineWorkspaceRoute(
  {
    operation: "checkout.mock-hosted-payment",
    cancellation: "continue-after-disconnect",
    caller: "client",
  },
  (request) => {
    const handler =
      request.method === "POST"
        ? submitMockHostedPaymentDecision
        : readMockHostedPaymentPage;
    return handler(request).pipe(
      Effect.mapError(
        WorkspaceRouteFailure.internal("Test payment is unavailable.")
      ),
      Effect.provide(WorkspaceDatabase.Default)
    );
  }
);

export const mockHostedPaymentRoute = (request: Request) =>
  isMockPaymentEnabled()
    ? handleMockHostedPaymentRoute(request)
    : Promise.resolve(notFound());
