import type { AccountPasses } from "@/features/account/account-passes.server";
import type { AccountUnlimitedPasses } from "@/features/account/account-unlimited-passes.server";
import { AccountPassesPanel } from "@/features/account/components/account-passes";
import { AccountSignInRedirect } from "@/features/account/components/account-sign-in-redirect";
import { InvoiceHistoryPanel } from "@/features/account/components/billing/invoice-history";
import { ReservationHistory } from "@/features/account/components/reservation-history";
import { SessionRefresh } from "@/features/account/components/session-refresh";
import {
  AccountUnavailableCard,
  SignedInAccount,
  type SignedInAccountState,
} from "@/features/account/components/signed-in-account";
import type {
  CustomerInvoiceHistory,
  CustomerReservationHistory,
} from "@/features/account/contracts";
import type { CustomerAccountPageState } from "@/features/account/page-data.server";
import type { Locale } from "@/features/i18n";

export function AccountPage({
  loadInvoiceHistory,
  loadPasses,
  locale,
  state,
  unlimitedPasses = [],
}: {
  /**
   * Starts loading the account's invoice history. Only a linked or review
   * account's page calls it, and the history streams into the Billing
   * section without holding up the page.
   */
  readonly loadInvoiceHistory: () => Promise<CustomerInvoiceHistory>;
  readonly loadPasses?: () => Promise<AccountPasses>;
  readonly locale: Locale;
  readonly state: CustomerAccountPageState;
  readonly unlimitedPasses?: AccountUnlimitedPasses;
}) {
  if (state.kind === "unauthenticated") {
    return <AccountSignInRedirect locale={locale} />;
  }
  if (state.kind === "unavailable") {
    return <AccountUnavailableCard locale={locale} />;
  }

  return (
    <>
      <SessionRefresh />
      <SignedInAccount
        invoices={
          (state.kind === "linked" || state.kind === "review-account") && (
            <InvoiceHistoryPanel
              history={loadInvoiceHistory()}
              locale={locale}
            />
          )
        }
        locale={locale}
        passes={
          loadPasses && state.kind !== "deletion-pending" ? (
            <AccountPassesPanel
              locale={locale}
              packs={loadPasses()}
              unlimitedPasses={unlimitedPasses}
            />
          ) : undefined
        }
        state={withRenderedReservations(state, locale, unlimitedPasses)}
      />
    </>
  );
}

/**
 * Renders the state's reservation history on the server, where its `Intl`
 * dates are formatted, and leaves the history itself out of the client view.
 */
function withRenderedReservations(
  state: Exclude<
    CustomerAccountPageState,
    { readonly kind: "unauthenticated" | "unavailable" }
  >,
  locale: Locale,
  unlimitedPasses: AccountUnlimitedPasses
): SignedInAccountState {
  const currentPassCount =
    unlimitedPasses === "unavailable"
      ? undefined
      : unlimitedPasses.filter(
          (pass) => pass.status === "active" || pass.status === "upcoming"
        ).length;
  const render = (history?: CustomerReservationHistory) => ({
    count:
      history?.kind === "available" && currentPassCount !== undefined
        ? history.groups.current.length + currentPassCount
        : undefined,
    history: (
      <ReservationHistory
        history={history}
        locale={locale}
        unlimitedPasses={unlimitedPasses}
      />
    ),
  });
  switch (state.kind) {
    case "linked":
    case "review-account": {
      const { history, ...rest } = state;
      return { ...rest, reservations: render(history) };
    }
    case "completion-required":
    case "support-required": {
      const { history, ...rest } = state;
      if (history) return { ...rest, reservations: render(history) };
      if (unlimitedPasses !== "unavailable" && unlimitedPasses.length === 0)
        return rest;
      return {
        ...rest,
        reservations: render({
          kind: "available",
          groups: { current: [], past: [], unavailable: [] },
        }),
      };
    }
    case "authenticated-unavailable": {
      // The holder's pass periods can load independently of the profile.
      if (unlimitedPasses === "unavailable" || unlimitedPasses.length === 0)
        return state;
      return {
        ...state,
        reservations: render(),
      };
    }
    case "deletion-pending":
      return state;
  }
}
