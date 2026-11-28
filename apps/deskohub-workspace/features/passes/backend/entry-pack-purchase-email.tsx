import "server-only";

import {
  EmailConfigTag,
  type EmailRecipient,
  EmailServiceTag,
} from "@deskohub/email";
import { Effect } from "effect";
import type { passPurchases } from "@/db/schema";
import {
  EntryPackPurchaseEmail,
  entryPackPurchaseEmailSubject,
} from "@/emails/entry-pack-purchase";
import { env } from "@/env";
import type { PassPurchaseAccountingSnapshot } from "@/features/accounting/accounting-document-snapshot";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { reservationStatusPath } from "@/features/reservation/routes";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import { emailKindTags } from "@/shared/backend/email/email-kind";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";
import { passConfirmationEmailKinds } from "./pass-confirmation-email-kind";
import { createUnlimitedAccessUrl } from "./unlimited-access-capability";

export const sendEntryPackPurchaseEmail = Effect.fn(
  "sendEntryPackPurchaseEmail"
)(function* (input: {
  readonly purchase: typeof passPurchases.$inferSelect;
  readonly price: Pick<
    PassPurchaseAccountingSnapshot,
    "quote" | "coffeeAmountMinor"
  >;
  readonly paidAt: Temporal.Instant;
  readonly paymentAttemptId: PaymentAttemptId;
  readonly buyer: EmailRecipient;
  readonly holderEmail: string | null;
  readonly gift?: boolean;
  readonly invitationSent?: boolean;
  readonly invoiceRequested: boolean;
  readonly earlyStartRequested: boolean;
}) {
  const { purchase, buyer } = input;
  const { locale, id } = purchase;
  const origin = yield* getWorkspaceRuntimeCallbackOrigin;
  const mailer = yield* EmailServiceTag;
  const { defaultFrom } = yield* EmailConfigTag;
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
      quote={input.price.quote}
      paidAt={input.paidAt}
      statusUrl={
        new URL(`/${locale}${reservationStatusPath}/${id}`, origin).href
      }
      termsUrl={
        new URL(getLegalDocumentPath(locale, "terms-and-conditions"), origin)
          .href
      }
      invoiceRequested={input.invoiceRequested}
      earlyStartRequested={input.earlyStartRequested}
      coffeeAmountMinor={input.price.coffeeAmountMinor}
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
    ...emailKindTags(passConfirmationEmailKinds[purchase.product], {
      orderId: id,
      paymentAttemptId: input.paymentAttemptId,
      deploymentEnvironment: env.VERCEL_ENV,
    }),
    sensitiveContent: true,
  });
});
