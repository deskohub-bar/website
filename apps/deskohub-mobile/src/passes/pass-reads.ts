import type {
  CustomerBookableCoworkTier,
  CustomerLocale,
  CustomerMonitorOption,
} from "@deskohub/workspace-customer-api";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { PragueDate } from "../booking/selection/prague-date";
import { CustomerApi } from "../customer-api/customer-api.service";
import { customerDataRuntime } from "../customer-api/customer-data-runtime";
import {
  customerRead,
  customerWrite,
  refreshAfterWrite,
} from "../customer-api/customer-request";

const passes = Effect.map(Effect.service(CustomerApi), (api) => api.passes);
const workspaceRead = customerRead({ accountRead: false });

export const passCatalogAtom = customerDataRuntime.atom(
  Effect.flatMap(passes, (api) => api.listPassOffers()).pipe(workspaceRead)
);

export const heldPassesAtom = Atom.family((locale: CustomerLocale) =>
  customerDataRuntime.atom(
    Effect.flatMap(passes, (api) => api.listPasses({ query: { locale } })).pipe(
      workspaceRead
    )
  )
);

export const passBookingOptionsAtom = Atom.family(
  (key: {
    readonly date: PragueDate;
    readonly tier: CustomerBookableCoworkTier;
    readonly monitorOption?: CustomerMonitorOption;
    readonly stay?: "day" | "overnight";
  }) =>
    customerDataRuntime.atom(
      Effect.flatMap(passes, (api) =>
        api.getPassBookingOptions({ query: key })
      ).pipe(workspaceRead)
    )
);

export const unlimitedAccessAtom = Atom.family((passId: string) =>
  customerDataRuntime.atom(
    Effect.flatMap(passes, (api) =>
      api.getUnlimitedAccess({ params: { passId } })
    ).pipe(customerRead({ accountRead: true }))
  )
);

export const resendPassInvitationAtom = customerDataRuntime.fn(
  (
    {
      passId,
      locale,
    }: { readonly passId: string; readonly locale: CustomerLocale },
    get
  ) =>
    Effect.flatMap(passes, (api) =>
      api.resendPassInvitation({ params: { passId } })
    ).pipe(customerWrite, refreshAfterWrite(get, [heldPassesAtom(locale)]))
);
