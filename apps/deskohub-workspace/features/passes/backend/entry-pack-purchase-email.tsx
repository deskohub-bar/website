import "server-only";

import {
  EmailConfigTag,
  type EmailRecipient,
  EmailServiceTag,
} from "@deskohub/email";
import { Effect, Schema } from "effect";
import type { passPurchases } from "@/db/schema";
import {
  EntryPackPurchaseEmail,
  entryPackPurchaseEmailSubject,
} from "@/emails/entry-pack-purchase";
import { env } from "@/env";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { discountQuoteCodec } from "@/features/discounts/contracts";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { reservationStatusPath } from "@/features/reservation/routes";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import { emailKindTags } from "@/shared/backend/email/email-kind";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";
import { createUnlimitedAccessUrl } from "./unlimited-access-capability";
import { unlimitedConfirmationEmailKind } from "./unlimited-confirmation-email-kind";

export const sendEntryPackPurchaseEmail = Effect.fn(
  "sendEntryPackPurchaseEmail"
)(function* (input: {
  readonly purchase: typeof passPurchases.$inferSelect;
  readonly paidAt: Temporal.Instant;
  readonly paymentAttemptId: PaymentAttemptId;
  readonly buyer: EmailRecipient;
  readonly holderEmail: string | null;
  readonly gift?: boolean;
  readonly invitationSent?: boolean;
  readonly invoiceRequested: boolean;
}) {
  const { purchase, buyer } = input;
  const { locale, id } = purchase;
  const origin = yield* getWorkspaceRuntimeCallbackOrigin;
  const mailer = yield* EmailServiceTag;
  const { defaultFrom } = yield* EmailConfigTag;
  const quote = yield* Schema.decodeUnknownEffect(discountQuoteCodec)(
    purchase.quote
  );
  const accessUrl =
    purchase.product === "unlimited" &&
    !input.gift &&
    purchase.holderAccountId === purchase.buyerAccountId
      ? yield* createUnlimitedAccessUrl({
          orderId: id,
          holderAccountId: purchase.holderAccountId,
          locale,
          origin,
        })
      : undefined;
  const rendered = yield* renderWorkspaceEmail(
    <EntryPackPurchaseEmail
      {...purchase}
      orderId={id}
      holderEmail={input.holderEmail}
      gift={input.gift}
      invitationSent={input.invitationSent}
      quote={quote}
      paidAt={input.paidAt}
      statusUrl={
        new URL(`/${locale}${reservationStatusPath}/${id}`, origin).href
      }
      termsUrl={
        new URL(getLegalDocumentPath(locale, "terms-and-conditions"), origin)
          .href
      }
      invoiceRequested={input.invoiceRequested}
      unlimitedCoffee={purchase.unlimitedCoffee === true}
      accessUrl={accessUrl}
    />
  );

  return yield* mailer.send({
    ...rendered,
    from: defaultFrom,
    to: buyer,
    subject: entryPackPurchaseEmailSubject({
      locale,
      entryCount: purchase.entryCount,
    }),
    idempotencyKey: `entry-pack-purchase:${id}`,
    ...(purchase.product === "unlimited"
      ? emailKindTags(unlimitedConfirmationEmailKind, {
          orderId: id,
          paymentAttemptId: input.paymentAttemptId,
          deploymentEnvironment: env.VERCEL_ENV,
        })
      : { tags: ["entry_pack_purchase"] }),
    sensitiveContent: true,
  });
});
