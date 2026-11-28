import type { WorkspaceProductTarget } from "@deskohub/workspace-domain/features/discounts/product-target";
import { workspaceTableProductTargetSchema } from "@deskohub/workspace-domain/features/reservation/table-reservation-product";

export {
  type WorkspaceProductTarget,
  workspaceProductTargetSchema,
} from "@deskohub/workspace-domain/features/discounts/product-target";

import { Array as Arr, Match } from "effect";
import { workspaceCoworkCurrentTiers } from "@/features/checkout/product-catalog";
import type { WorkspaceProductIdentity } from "@/features/checkout/product-identity";
import {
  entryPackOffers,
  getPassProductKey,
  unlimitedPassOffers,
} from "@/features/passes/pass-offer";
import { workspaceCoworkProductTargetSchema } from "@/features/reservation/cowork-reservation-product";
import { workspaceMeetingRoomProductTargetSchema } from "@/features/reservation/meeting-room-reservation";
import { workspaceOfficeProductTargetSchema } from "@/features/reservation/office-reservation";

const entryPackFamilyTarget = { kind: "entry-pack" } as const;
const unlimitedFamilyTarget = { kind: "unlimited" } as const;

export const workspacePassOfferTargets = [
  ...entryPackOffers.map(({ product }) => product),
  ...unlimitedPassOffers.map(({ product }) => product),
];

export type WorkspaceProductFamily = WorkspaceProductTarget["kind"];

const reservationProductTargets = [
  { kind: "cowork" },
  { kind: "meeting-room" },
  { kind: "office" },
  { kind: "table" },
] as const satisfies readonly WorkspaceProductTarget[];

const reservationProductFamilies = reservationProductTargets.map(
  ({ kind }) => kind
);

export const workspaceReservationProductFamilies: readonly WorkspaceProductFamily[] =
  reservationProductFamilies;

export const isReservationProductTarget = (
  target: WorkspaceProductTarget
): target is Extract<
  WorkspaceProductTarget,
  { kind: (typeof reservationProductFamilies)[number] }
> => reservationProductFamilies.some((kind) => target.kind === kind);

/** Family targets, each covering every product of its family. */
export const workspaceProductTargets = Arr.appendAll(
  reservationProductTargets,
  [entryPackFamilyTarget, unlimitedFamilyTarget]
) satisfies readonly WorkspaceProductTarget[];

/** Cowork tier targets, each covering one saleable cowork tier. */
export const workspaceCoworkTierProductTargets =
  workspaceCoworkCurrentTiers.map((tier) => ({
    kind: "cowork" as const,
    tier,
  })) satisfies readonly WorkspaceProductTarget[];

export type WorkspaceProductTargetKey =
  | WorkspaceProductFamily
  | `cowork:${(typeof workspaceCoworkCurrentTiers)[number]}`
  | ReturnType<typeof getPassProductKey>;

export const getWorkspaceProductTargetKey = (
  target: WorkspaceProductTarget
): WorkspaceProductTargetKey => {
  if (target.kind === "cowork" && target.tier !== undefined) {
    return `cowork:${target.tier}`;
  }
  if (
    (target.kind === "entry-pack" || target.kind === "unlimited") &&
    target.tier !== undefined
  ) {
    return getPassProductKey(target);
  }
  return target.kind;
};

/**
 * Every target value that covers the product: its family target and, for a
 * saleable cowork tier, that tier's target.
 */
export const getWorkspaceProductTargetsCovering = (
  product: WorkspaceProductIdentity
): readonly [WorkspaceProductTarget, ...WorkspaceProductTarget[]] =>
  Match.value(product).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: ({ tier }) => {
        const family = workspaceCoworkProductTargetSchema.make({
          kind: "cowork",
        });
        const tierTarget = workspaceCoworkTierProductTargets.find(
          (target) => target.tier === tier
        );
        return tierTarget
          ? ([
              family,
              workspaceCoworkProductTargetSchema.make(tierTarget),
            ] as const)
          : ([family] as const);
      },
      "meeting-room": () =>
        [
          workspaceMeetingRoomProductTargetSchema.make({
            kind: "meeting-room",
          }),
        ] as const,
      office: () =>
        [workspaceOfficeProductTargetSchema.make({ kind: "office" })] as const,
      table: () =>
        [workspaceTableProductTargetSchema.make({ kind: "table" })] as const,
      "entry-pack": (product) => [entryPackFamilyTarget, product] as const,
      unlimited: (product) => [unlimitedFamilyTarget, product] as const,
    })
  );

export const workspaceProductTargetMatches = (
  target: WorkspaceProductTarget,
  product: WorkspaceProductIdentity
): boolean =>
  getWorkspaceProductTargetsCovering(product).some(
    (covering) =>
      getWorkspaceProductTargetKey(covering) ===
      getWorkspaceProductTargetKey(target)
  );

/** Whether the targets together cover every product of the family. */
export const workspaceProductTargetsCoverFamily = (
  targets: readonly WorkspaceProductTarget[],
  family: WorkspaceProductFamily
): boolean => {
  const keys = new Set(targets.map(getWorkspaceProductTargetKey));
  return (
    keys.has(family) ||
    (family === "cowork" &&
      workspaceCoworkTierProductTargets.every((target) =>
        keys.has(getWorkspaceProductTargetKey(target))
      )) ||
    ((family === "entry-pack" || family === "unlimited") &&
      workspacePassOfferTargets
        .filter((target) => target.kind === family)
        .every((target) => keys.has(getWorkspaceProductTargetKey(target))))
  );
};

/**
 * Describes why a discount's targets are incoherent: a repeated target, or a
 * family target alongside one of its tier targets.
 */
export const findWorkspaceProductTargetsIssue = (
  targets: readonly WorkspaceProductTarget[]
): string | undefined => {
  const keys = targets.map(getWorkspaceProductTargetKey);
  if (new Set(keys).size !== keys.length) {
    return "product targets must be unique";
  }
  for (const target of targets) {
    if (
      keys.includes(target.kind) &&
      getWorkspaceProductTargetKey(target) !== target.kind
    ) {
      return target.kind === "cowork"
        ? "a cowork target covering every tier cannot be combined with cowork tier targets"
        : "a pass family target cannot be combined with its offer targets";
    }
  }
  return undefined;
};
