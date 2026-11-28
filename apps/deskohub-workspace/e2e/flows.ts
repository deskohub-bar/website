import {
  classifyE2EStatusDescription,
  diffFlowIds,
  findCoveringCarriedSource,
  formatE2EStatusDescription,
  parseFlowsInput,
  parsePrBodyE2EFlows,
  summarizeCommitStatuses,
  unionFlowIds,
  WORKSPACE_E2E_FLOW_IDS,
  WORKSPACE_E2E_FLOW_SHORT_CODES,
} from "../../../.github/actions/workspace-e2e-flows/flows.mjs";
import type { WorkspaceE2ECaseId } from "./playwright-checkout/case-catalog";

export const workspaceE2EFlowIds = [
  "checkout-cowork",
  "checkout-meeting-room",
  "checkout-office",
  "checkout-table",
  "payments",
  "discounts",
  "referrals",
  "agent-booking",
  "account",
  "admin",
  "email-campaigns",
  "access-codes",
  "public-site",
  "webkit",
] as const;

export type WorkspaceE2EFlowId = (typeof workspaceE2EFlowIds)[number];

export type WorkspaceE2EFlowSelection =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | {
      readonly kind: "subset";
      readonly flows: ReadonlySet<WorkspaceE2EFlowId>;
    };

export const workspaceE2EFlowShortCodes: Readonly<
  Record<WorkspaceE2EFlowId, string>
> = WORKSPACE_E2E_FLOW_SHORT_CODES;

export const workspaceE2EWorkflowFlowIds: readonly string[] =
  WORKSPACE_E2E_FLOW_IDS;

/**
 * Every checkout-pool case belongs to one flow. The compiler rejects a new
 * case in `case-catalog.ts` until it is assigned here.
 */
export const workspaceE2ECaseFlowById = {
  "automation-reservation-booked": "email-campaigns",
  "voucher-reuse-and-exhaustion": "discounts",
  "discount-code-capacity-reached": "discounts",
  "referral-profile-completion-checkout": "referrals",
  "checkout-signed-out-verification": "checkout-cowork",
  "reservation-link-meeting-room-zero-total-en-US": "checkout-meeting-room",
  "discount-code-already-redeemed": "discounts",
  "referral-checkout-code-entry": "referrals",
  "checkout-meeting-room-zero-total-four-hours": "checkout-meeting-room",
  "reservation-replacement": "checkout-cowork",
  "referral-referrer-screen": "referrals",
  "meeting-room-reservation-replacement": "checkout-meeting-room",
  "checkout-zero-total": "checkout-cowork",
  "calendar-sale-pricing-changes": "discounts",
  "reservation-link-meeting-room-unknown-code-en-US": "checkout-meeting-room",
  "referral-share-link-checkout": "referrals",
  "reservation-link-meeting-room-zero-total-cs-CZ": "checkout-meeting-room",
  "referral-auto-linked-sign-in": "referrals",
  "discount-code-expires-before-payment": "discounts",
  "customer-discount-changes-before-payment": "discounts",
  "locale-switch": "public-site",
  "locale-smoke-de-de": "public-site",
  "locale-smoke-uk-ua": "public-site",
  "locale-smoke-sk-sk": "public-site",
  "locale-smoke-vi-vn": "public-site",
  "locale-smoke-hi-in": "public-site",
  "discount-code-unknown": "discounts",
  "discount-code-customer-ineligible": "discounts",
  "reservation-url-state-cowork": "checkout-cowork",
  "reservation-url-state-office-starts-on-link": "checkout-office",
  "referral-profile-completion-unusable-link": "referrals",
  "reservation-url-state-office": "checkout-office",
  "reservation-url-state-table": "checkout-table",
  "reservation-url-state-meeting-room": "checkout-meeting-room",
  "contact-form": "public-site",
  "checkout-calendar-sale": "discounts",
  "checkout-referral-someone-else": "referrals",
  "payment-late-recovery-recreated": "payments",
  "checkout-meeting-room-paid-one-hour": "checkout-meeting-room",
  "checkout-meeting-room-paid-whole-day": "checkout-meeting-room",
  "checkout-agent-booking": "agent-booking",
  "checkout-cowork-basic": "checkout-cowork",
  "checkout-all-discounts": "discounts",
  "checkout-office-paid-multi-day": "checkout-office",
  "checkout-table-paid": "checkout-table",
  "payment-late-recovery-refund-required": "payments",
  "checkout-voucher-full-usage": "discounts",
  "checkout-discount-code": "discounts",
  "payment-authentication-failed": "payments",
  "payment-meeting-room-cancelled": "payments",
  "payment-cancelled": "payments",
} as const satisfies Readonly<Record<WorkspaceE2ECaseId, WorkspaceE2EFlowId>>;

/**
 * Flows whose checkout-pool cases need discount seeding, Dotypos discount
 * group lookup, and cowork/meeting-room/office/table availability preparation.
 * `public-site` cases (`contact-form`, `locale-switch`, `locale-smoke-*`)
 * never book or read prepared availability.
 */
const checkoutPreparationFlows: ReadonlySet<WorkspaceE2EFlowId> =
  new Set<WorkspaceE2EFlowId>([
    "checkout-cowork",
    "checkout-meeting-room",
    "checkout-office",
    "checkout-table",
    "payments",
    "discounts",
    "referrals",
    "agent-booking",
  ]);

/**
 * Non-case-pool projects in `playwright.e2e.config.ts` and the flow that
 * enables each.
 */
export const workspaceE2ECheckoutProjectFlowByName = {
  "account-auth": "account",
  "administrator-access": "admin",
  "email-campaign-recipient-preview": "email-campaigns",
  "access-code-creation": "access-codes",
} as const satisfies Readonly<Record<string, WorkspaceE2EFlowId>>;

/**
 * Every test file in `e2e/instant-navigation/` (excluding administrator
 * setup/cleanup lifecycle fixtures) mapped to its owning flow.
 */
export const workspaceE2EInstantNavigationSpecFlowByFile = {
  "account-navigation.pw.ts": "account",
  "admin-navigation.pw.ts": "admin",
  "customer-mcp.pw.ts": "agent-booking",
  "customer-route-fallbacks.pw.ts": "public-site",
  "public-account-legal.pw.ts": "public-site",
  "public-navigation.pw.ts": "public-site",
  "reservation-navigation.pw.ts": "public-site",
  "site-tools.pw.ts": "agent-booking",
  "temporal-runtime.pw.ts": "webkit",
} as const satisfies Readonly<Record<string, WorkspaceE2EFlowId>>;

export type WorkspaceE2EInstantNavigationSpecFile =
  keyof typeof workspaceE2EInstantNavigationSpecFlowByFile;

export const parseWorkspaceE2EFlowsInput = (
  raw: string
):
  | {
      readonly ok: true;
      readonly selection: WorkspaceE2EFlowSelection;
      readonly canonical: string;
      readonly installWebkit: boolean;
      readonly runE2E: boolean;
    }
  | { readonly ok: false; readonly error: string } => {
  const parsed = parseFlowsInput(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  let selection: WorkspaceE2EFlowSelection;
  if (parsed.kind === "all") {
    selection = { kind: "all" };
  } else if (parsed.kind === "none") {
    selection = { kind: "none" };
  } else {
    selection = {
      kind: "subset",
      flows: new Set(parsed.selected),
    };
  }
  return {
    ok: true,
    selection,
    canonical: parsed.flows,
    installWebkit: parsed.installWebkit,
    runE2E: parsed.runE2E,
  };
};

export const resolveWorkspaceE2EFlowSelection = (
  raw: string | undefined
): WorkspaceE2EFlowSelection => {
  if (raw === undefined || raw.trim() === "") {
    return { kind: "all" };
  }
  const parsed = parseWorkspaceE2EFlowsInput(raw);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.selection;
};

export const isWorkspaceE2EFlowSelected = (
  flowId: WorkspaceE2EFlowId,
  selection: WorkspaceE2EFlowSelection
): boolean => {
  if (selection.kind === "all") return true;
  if (selection.kind === "none") return false;
  return selection.flows.has(flowId);
};

export const isWorkspaceE2ECaseSelected = (
  caseId: WorkspaceE2ECaseId,
  selection: WorkspaceE2EFlowSelection
): boolean =>
  isWorkspaceE2EFlowSelected(workspaceE2ECaseFlowById[caseId], selection);

export const needsWorkspaceE2ECheckoutPreparation = (
  selection: WorkspaceE2EFlowSelection,
  options: { readonly includeNightlyCases?: boolean } = {}
): boolean => {
  if (selection.kind === "all") return true;
  if (selection.kind === "none") return false;
  for (const flow of selection.flows) {
    if (checkoutPreparationFlows.has(flow)) return true;
  }
  return (
    options.includeNightlyCases === true &&
    selection.flows.has("email-campaigns")
  );
};

/**
 * Selects the Playwright projects to pass to `playwright.e2e.config.ts`.
 * Returns `undefined` when all projects should run unfiltered, or `[]` when
 * the checkout Playwright config does not need to start at all.
 */
export const selectedWorkspaceE2ECheckoutProjects = (
  selection: WorkspaceE2EFlowSelection,
  options: { readonly includeNightlyCases?: boolean } = {}
): readonly string[] | undefined => {
  if (selection.kind === "all") return undefined;
  if (selection.kind === "none") return [];

  const projects: string[] = [];
  if (
    isWorkspaceE2EFlowSelected(
      workspaceE2ECheckoutProjectFlowByName["account-auth"],
      selection
    )
  ) {
    projects.push("account-auth");
  }
  const hasCheckoutPoolCase =
    needsWorkspaceE2ECheckoutPreparation(selection, options) ||
    isWorkspaceE2EFlowSelected("public-site", selection);
  if (hasCheckoutPoolCase) {
    projects.push("checkout-cases");
  }
  for (const project of [
    "administrator-access",
    "email-campaign-recipient-preview",
    "access-code-creation",
  ] as const) {
    if (
      isWorkspaceE2EFlowSelected(
        workspaceE2ECheckoutProjectFlowByName[project],
        selection
      )
    ) {
      projects.push(project);
    }
  }
  return projects;
};

/**
 * Selects the Playwright projects and `navigation` spec files for
 * `playwright.instant-navigation.config.ts`.
 */
export const selectedWorkspaceE2EInstantNavigationPlan = (
  selection: WorkspaceE2EFlowSelection
): {
  readonly projects: readonly string[] | undefined;
  readonly navigationSpecs: readonly WorkspaceE2EInstantNavigationSpecFile[];
} => {
  const allNavigationSpecs = Object.keys(
    workspaceE2EInstantNavigationSpecFlowByFile
  ).filter(
    (file): file is WorkspaceE2EInstantNavigationSpecFile =>
      file !== "admin-navigation.pw.ts" &&
      Object.hasOwn(workspaceE2EInstantNavigationSpecFlowByFile, file)
  );

  if (selection.kind === "all") {
    return { projects: undefined, navigationSpecs: allNavigationSpecs };
  }
  if (selection.kind === "none") {
    return { projects: [], navigationSpecs: [] };
  }

  const navigationSpecs = allNavigationSpecs.filter((file) =>
    isWorkspaceE2EFlowSelected(
      workspaceE2EInstantNavigationSpecFlowByFile[file],
      selection
    )
  );
  const projects: string[] = [];
  if (isWorkspaceE2EFlowSelected("admin", selection)) {
    projects.push("administration-navigation");
  }
  if (navigationSpecs.length > 0) {
    projects.push("navigation");
  }
  if (isWorkspaceE2EFlowSelected("webkit", selection)) {
    projects.push("webkit");
  }
  return { projects, navigationSpecs };
};

export {
  classifyE2EStatusDescription,
  diffFlowIds,
  findCoveringCarriedSource,
  formatE2EStatusDescription,
  parsePrBodyE2EFlows,
  summarizeCommitStatuses,
  unionFlowIds,
};
