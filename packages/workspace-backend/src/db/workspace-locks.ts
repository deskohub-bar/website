import type { DotyposCustomerId } from "@deskohub/dotypos";
import type { CustomerAccountId } from "@deskohub/workspace-domain/features/account/customer-account";
import type { OrderId } from "@deskohub/workspace-domain/features/order/order";
import type { WorkspaceReservationId } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import { Effect, Order } from "effect";
import { WorkspaceTransaction } from "./database.service";
import type { DatabaseQueryError } from "./sql-constraint";
import {
  holdSection,
  holdSections,
  type LockWait,
  sectionHolds,
  type TransactionLockRequest,
  takeTransactionLock,
} from "./workspace-lock-ledger";

type TransactionLock = Effect.Effect<
  void,
  DatabaseQueryError,
  WorkspaceTransaction
>;

/** Reads the marker so every lock requires an open Workspace transaction. */
const take = (lock: TransactionLockRequest): TransactionLock =>
  Effect.andThen(WorkspaceTransaction, takeTransactionLock(lock));

const customerAccount = (accountId: CustomerAccountId): TransactionLock =>
  take({
    name: "customerAccount",
    rank: 20,
    pair: ["customer-account", accountId],
  });

const reservationInviteeNotices = (orderId: WorkspaceReservationId) => ({
  name: "reservationInviteeNotices",
  rank: 55,
  pair: ["reservation-invitee-notices", orderId] as const,
});

const customerAccountSection = (accountId: CustomerAccountId) => ({
  name: "customerAccount",
  rank: 20,
  pair: ["customer-account", accountId] as const,
});

const passPurchaseFulfillmentSection = (orderId: OrderId) => ({
  name: "passPurchaseFulfillment",
  rank: 30,
  pair: ["pass-purchase-fulfillment", orderId] as const,
});

const reservationOrderSection = (orderId: WorkspaceReservationId) => ({
  name: "reservationOrder",
  rank: 5,
  pair: ["reservation-order", orderId] as const,
});

/** Takes two existing section keys together without another pool permit. */
export const holdCustomerAccountAndPassPurchase = (
  accountId: CustomerAccountId,
  orderId: OrderId
) =>
  holdSections([
    customerAccountSection(accountId),
    passPurchaseFulfillmentSection(orderId),
  ]);

/**
 * Advisory locks held until the current Workspace transaction ends. Take them
 * in ascending rank; equal ranks in ascending key. Each keeps its
 * pre-registry encoding exactly, so old and new code lock the same key during
 * a rollout.
 *
 * The reservation order mirror takes no advisory lock. Its triggers take row
 * locks only: the reservation row, then its order row, inside the
 * reservation's own statement. Payment attempt foreign key checks take
 * `KEY SHARE` on the order row, which never waits on the mirror.
 */
export const WorkspaceLocks = {
  referralGraph: (wait?: LockWait): TransactionLock =>
    take({
      name: "referralGraph",
      rank: 10,
      pair: ["referral-attribution", "graph"],
      wait,
    }),
  customerAccount,
  /** Every account, deduplicated, in ascending ID order. */
  customerAccounts: (
    accountIds: Iterable<CustomerAccountId>
  ): TransactionLock =>
    Effect.forEach(
      Array.from(new Set(accountIds)).sort(Order.String),
      customerAccount,
      { discard: true }
    ),
  /**
   * Serializes an account's analytics consent decisions, so a decision that
   * may only seed an empty ledger sees every decision recorded before it.
   */
  analyticsConsentLedger: (accountId: CustomerAccountId): TransactionLock =>
    take({
      name: "analyticsConsentLedger",
      rank: 25,
      pair: ["analytics-consent-ledger", accountId],
    }),
  referralFirstBooking: (customerId: DotyposCustomerId): TransactionLock =>
    take({
      name: "referralFirstBooking",
      rank: 30,
      pair: ["referral-first-booking", customerId],
    }),
  checkoutSession: (lockKey: bigint): TransactionLock =>
    take({ name: "checkoutSession", rank: 40, bigint: lockKey }),
  entryPackHolder: (accountId: CustomerAccountId): TransactionLock =>
    take({
      name: "entryPackHolder",
      rank: 41,
      pair: ["entry-pack-holder", accountId],
    }),
  manualInvoiceCreation: (invoiceId: string): TransactionLock =>
    take({
      name: "manualInvoiceCreation",
      rank: 50,
      pair: ["manual-invoice-creation", invoiceId],
    }),
  manualInvoiceNewCustomer: (): TransactionLock =>
    take({
      name: "manualInvoiceNewCustomer",
      rank: 51,
      pair: ["manual-invoice-new-customer", "global"],
    }),
  /** A single `hashtext` key, sharing the one-bigint space with `checkoutSession`. */
  manualInvoiceIssue: (invoiceId: string): TransactionLock =>
    take({ name: "manualInvoiceIssue", rank: 52, hashed: invoiceId }),
  reservationInviteeNotices: (orderId: WorkspaceReservationId) =>
    take(reservationInviteeNotices(orderId)),
  automationFireEntry: (campaignId: string): TransactionLock =>
    take({
      name: "automationFireEntry",
      rank: 60,
      pair: ["email-automation-fire-entry", campaignId],
    }),
  passReminderCampaign: (triggerKind: string): TransactionLock =>
    take({
      name: "passReminderCampaign",
      rank: 61,
      pair: ["email-pass-reminder-campaign", triggerKind],
    }),
  requestBudget: (policyKey: string): TransactionLock =>
    take({
      name: "requestBudget",
      rank: 70,
      pair: ["request-budget", policyKey],
    }),
  standaloneAccessCodeDevice: (deviceWindowKey: string): TransactionLock =>
    take({
      name: "standaloneAccessCodeDevice",
      rank: 80,
      pair: ["standalone-access-code", deviceWindowKey],
    }),
  legacyAdministrator: (legacyUsername: string): TransactionLock =>
    take({
      name: "legacyAdministrator",
      rank: 85,
      pair: ["legacy-administrator", legacyUsername],
    }),
  /** Always the transaction's last lock. */
  automationUnitSlots: (): TransactionLock =>
    take({
      name: "automationUnitSlots",
      rank: 90,
      pair: ["email-automation-unit-slots", "engine"],
    }),
} as const;

/** Holds the target and discovered source reservations in order by ID. */
export const holdWorkspaceReservationOrders = (
  target: WorkspaceReservationId,
  sources: readonly WorkspaceReservationId[]
) => {
  const others = [...new Set(sources)].filter((id) => id !== target);
  const first = reservationOrderSection(target);
  const ordered = [...others.map(reservationOrderSection), first].sort(
    (left, right) => Order.String(left.pair[1], right.pair[1])
  );
  return holdSections([ordered[0] ?? first, ...ordered.slice(1)]);
};

export const holdsCustomerAccountSection = (accountId: CustomerAccountId) =>
  sectionHolds(customerAccountSection(accountId));

/**
 * Session-held sections on a dedicated connection, for a lock held across
 * non-transactional work. They never provide `WorkspaceTransaction`; enter
 * them outside every Workspace transaction.
 *
 * Sections are declared in nesting order: a section may be entered inside one
 * declared before it, never inside one declared after it. Their ranks share
 * `WorkspaceLocks`' scale and ascend in declaration order, which is what the
 * check compares; the same section nests in ascending key order.
 */
export const WorkspaceLockSections = {
  signInEmail: (addressDigest: string) =>
    holdSection({
      name: "signInEmail",
      rank: 0,
      pair: ["sign-in-email", addressDigest],
    }),
  /**
   * Serializes the workflows that change an order's hold or settle its
   * payments outside a checkout: hold cleanup and late-payment recovery. Each
   * holds it across its provider calls, so one never sees the other's
   * half-done release. It ranks below every transaction lock those workflows
   * take (the referral locks first), so none of them needs a bounded wait;
   * a workflow that also needs the customer account section enters that
   * inside this one.
   */
  reservationOrder: (orderId: WorkspaceReservationId) =>
    holdSection(reservationOrderSection(orderId)),
  unlimitedPassRecovery: (orderId: OrderId) =>
    holdSection({
      name: "unlimitedPassRecovery",
      rank: 6,
      pair: ["unlimited-pass-recovery", orderId],
    }),
  customerAccount: (accountId: CustomerAccountId) =>
    holdSection(customerAccountSection(accountId)),
  /** All local dates touched by a booking, and any order holds it is to move. */
  reservationCapacity: (
    dates: readonly Temporal.PlainDate[],
    options?: {
      readonly movedReservations?: readonly WorkspaceReservationId[];
      readonly authorAccountId?: CustomerAccountId;
      readonly sourceAccountIds?: readonly CustomerAccountId[];
    }
  ) => {
    const [first, ...rest] = Array.from(new Set(dates.map(String)))
      .sort(Order.String)
      .map((date) => ({
        name: "reservationCapacity",
        rank: 21,
        pair: ["reservation-capacity", date] as const,
      }));
    if (!first) throw new Error("Reservation capacity locks require a date");
    const [firstOrder, ...remainingOrders] = Array.from(
      new Set(options?.movedReservations)
    )
      .sort(Order.String)
      .map(reservationOrderSection);
    const accounts = Array.from(
      new Set([
        ...(options?.authorAccountId ? [options.authorAccountId] : []),
        ...(options?.sourceAccountIds ?? []),
      ])
    )
      .sort(Order.String)
      .map(customerAccountSection);
    if (firstOrder) {
      return holdSections([
        firstOrder,
        ...remainingOrders,
        ...accounts,
        first,
        ...rest,
      ]);
    }
    const [account, ...remainingAccounts] = accounts;
    return account
      ? holdSections([account, ...remainingAccounts, first, ...rest])
      : holdSections([first, ...rest]);
  },
  unlimitedGiftCustomer: (holder: CustomerAccountId) =>
    holdSection({
      name: "unlimitedGiftCustomer",
      rank: 22,
      pair: ["unlimited-gift-customer", holder],
    }),
  passPurchaseFulfillment: (orderId: OrderId) =>
    holdSection(passPurchaseFulfillmentSection(orderId)),
  reservationInviteeNotices: (orderId: WorkspaceReservationId) =>
    holdSection(reservationInviteeNotices(orderId)),
} as const;
