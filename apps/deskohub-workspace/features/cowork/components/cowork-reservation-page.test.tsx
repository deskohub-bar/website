import { beforeEach, describe, expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Schema } from "effect";
import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import {
  type AdvertisedPriceRequest,
  getAdvertisedProductItem,
  type PreloadedAdvertisedPrice,
} from "@/features/checkout/advertised-price";
import {
  buildCoworkCheckoutSummary,
  buildCoworkReservationQuote,
} from "@/features/checkout/checkout-quote.test-utils";
import { PublicOfferingsStructuredData } from "@/features/checkout/components/public-offerings-structured-data";
import { getWorkspaceProductByTier } from "@/features/checkout/product-catalog";
import { discountIdSchema } from "@/features/discounts/contracts";
import { m } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import type { HeldEntryPack } from "@/features/passes/backend/held-entry-packs";
import { advertiseCowork } from "@/features/reservation/advertised-price.test-utils";
import { recordReservationPagePreloads } from "@/features/reservation/backend/reservation-page-preloads.service.mock";
import {
  type NormalizedCoworkReservationOrder,
  normalizedBasicCoworkReservationOrderSchema,
  normalizedOpenSpaceCoworkReservationOrderSchema,
  normalizedReservedDeskCoworkReservationOrderSchema,
} from "@/features/reservation/cowork-reservation";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { defaultReservationBillingSelection } from "@/features/reservation/reservation-billing";
import type { CustomerLastReservationForKind } from "@/features/reservation/reservation-existing-customer";
import { coworkReservationKind } from "@/features/reservation/reservation-kind";
import { getCoworkAvailabilityQueries } from "@/features/reservation/workspace-availability";
import { Button } from "@/shared/components/ui/button";
import { currencyCZK } from "@/shared/money/currencies";
import { moneyMajorAmount } from "@/shared/money/money";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  getCoworkBookingPasses,
  noCoworkBookingPasses,
} from "../cowork-entry-packs";

const janEmail = testEmailAddress("jan");

mock.module("next/root-params", () => ({
  locale: () => Promise.resolve("en-US"),
}));

let isRememberedOfferAvailable = true;
const isRememberedCoworkOfferAvailable = mock(() =>
  Effect.succeed(isRememberedOfferAvailable)
);
const existingCustomer = await import(
  "@/features/reservation/backend/reservation-existing-customer.server"
);
mock.module(
  "@/features/reservation/backend/reservation-existing-customer.server",
  () => ({
    ...existingCustomer,
    isRememberedCoworkOfferAvailable,
    isRememberedMeetingRoomReservationAvailable: () => Effect.succeed(false),
    loadReservationCheckoutAccount: () =>
      Promise.resolve({ status: "signed-out" }),
  })
);

const { CoworkOfferReplaced, coworkReservationPage } = await import(
  "./cowork-reservation-page"
);

// Each request preloads at the price the server advertises for it.
const loadAdvertisedPrices = mock(
  (
    requests: ReadonlyArray<AdvertisedPriceRequest>
  ): Effect.Effect<ReadonlyArray<PreloadedAdvertisedPrice>> =>
    Effect.succeed(
      requests.flatMap(({ reservation, ...request }) =>
        reservation.kind === coworkReservationKind
          ? [advertiseCowork({ ...request, reservation })]
          : []
      )
    )
);
const recordEveryPricePreload = () =>
  recordReservationPagePreloads({ advertisedPrices: loadAdvertisedPrices });
let preloads = recordEveryPricePreload();

type CoworkPageRequest = Parameters<
  typeof coworkReservationPage.loadContent
>[0];

/** What the page renders: its structured data and form, or a restart. */
const loadCoworkReservationContent = ({
  checkoutAccount = { status: "signed-out" },
  initialReservation,
  pageData = {
    entryPackOffered: false,
    bookingPasses: noCoworkBookingPasses,
    passPurchaseOffered: true,
    overnightStayOffered: false,
  },
  replacementToken = "signed-replacement-token",
  ...request
}: Omit<CoworkPageRequest, "checkoutAccount" | "pageData"> & {
  readonly checkoutAccount?: CoworkPageRequest["checkoutAccount"];
  readonly initialReservation?: NormalizedCoworkReservationOrder;
  readonly pageData?: CoworkPageRequest["pageData"];
  readonly replacementToken?: string;
}) =>
  Effect.runPromise(
    coworkReservationPage
      .loadContent({
        checkoutAccount,
        pageData,
        ...request,
        ...(initialReservation && {
          restoredReservation: {
            replacementToken,
            reservation: initialReservation,
          },
        }),
      })
      .pipe(Effect.provide(preloads.layer))
  );

/** The content's form and structured data offerings. */
const loadCoworkReservationForm = async (
  input: Parameters<typeof loadCoworkReservationContent>[0]
) => {
  const content = await loadCoworkReservationContent(input);
  if (content.kind !== "form") throw new Error("Expected the reservation form");
  return content;
};

/** The form the page renders beside its structured data. */
const renderCoworkReservationForm = async (
  input: Parameters<typeof loadCoworkReservationContent>[0]
) => (await loadCoworkReservationForm(input)).form;

beforeEach(() => {
  mock.clearAllMocks();
  preloads = recordEveryPricePreload();
});

const stubWorkspaceInstant = (
  run: () => Promise<void>,
  instant = "2099-07-30T13:01:00Z"
): Promise<void> => {
  const originalNow = Temporal.Now.instant;
  Temporal.Now.instant = () => Temporal.Instant.from(instant);

  return run().finally(() => {
    Temporal.Now.instant = originalNow;
  });
};

const decodeLegacyBasicReservation = Schema.decodeUnknownSync(
  normalizedBasicCoworkReservationOrderSchema
);

const decodeOpenSpaceReservation = Schema.decodeUnknownSync(
  normalizedOpenSpaceCoworkReservationOrderSchema
);

const decodeReservedDeskReservation = Schema.decodeUnknownSync(
  normalizedReservedDeskCoworkReservationOrderSchema
);

type CoworkForm = Awaited<ReturnType<typeof renderCoworkReservationForm>>;

const coworkPriceRequest = (
  locale: string,
  date: string,
  details:
    | { readonly entryTier: "open-space"; readonly coffee: boolean }
    | { readonly entryTier: "reserved-desk"; readonly workstation: boolean }
) => ({
  locale,
  reservation: {
    kind: "cowork",
    details: { kind: "cowork", ...details, date },
  },
});

// Every tier card, coffee choice, and the workstation addon for the date.
const everyCoworkPriceRequest = (locale: string, date: string) => [
  coworkPriceRequest(locale, date, { entryTier: "open-space", coffee: false }),
  coworkPriceRequest(locale, date, { entryTier: "open-space", coffee: true }),
  coworkPriceRequest(locale, date, {
    entryTier: "reserved-desk",
    workstation: false,
  }),
  coworkPriceRequest(locale, date, {
    entryTier: "reserved-desk",
    workstation: true,
  }),
];

/** The page preloads exactly the availability its form reads first. */
const expectPreloadedFormAvailability = (form: CoworkForm) => {
  const { initialValues, today } = form;
  const queries = Object.values(
    getCoworkAvailabilityQueries({ ...initialValues, today })
  );

  expect(preloads.availabilityPreloads).toHaveLength(1);
  expect(preloads.availabilityPreloads[0].queries).toEqual(queries);
  expect(form.initialAvailability?.map(({ query }) => query)).toEqual(queries);
};

/**
 * Locates the restart Button and returns its direct-child anchor's href.
 * A `next/link` `legacyBehavior` anchor wrapped inside the Button does not
 * count: only a plain document anchor as the Button's immediate child proves
 * document navigation.
 */
const getRestartButtonDirectChildAnchorHref = (
  node: ReactNode
): string | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const href = getRestartButtonDirectChildAnchorHref(child);
      if (href !== undefined) {
        return href;
      }
    }
    return undefined;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return undefined;
  }
  // biome-ignore lint/plugin: an identity check on the rendered element type passes no props.
  if (node.type === Button) {
    const { children } = node.props;
    const anchor = Array.isArray(children) ? children[0] : children;
    if (
      isValidElement<{ href?: string }>(anchor) &&
      anchor.type === "a" &&
      anchor.props.href !== undefined
    ) {
      return anchor.props.href;
    }
    return undefined;
  }
  return getRestartButtonDirectChildAnchorHref(node.props.children);
};

test("preloads every cowork price and the default selection's availability", async () =>
  stubWorkspaceInstant(async () => {
    const form = await renderCoworkReservationForm({
      locale: "en-US",
      searchParams: {},
    });

    expect(form.initialValues).toMatchObject({
      entryTier: "open-space",
      coffee: false,
      date: "2099-07-30",
    });
    expect(form.today).toBe("2099-07-30");

    expect(loadAdvertisedPrices).toHaveBeenCalledTimes(1);
    expect(preloads.advertisedPriceRequests[0]).toEqual(
      everyCoworkPriceRequest("en-US", "2099-07-30")
    );
    expect(form.initialAdvertisedPrices).toHaveLength(4);
    expectPreloadedFormAvailability(form);
    expect(preloads.availabilityPreloads[0].queries).toEqual([
      {
        kind: "cowork",
        from: "2099-07-30",
        to: "2100-01-30",
        entryTier: "open-space",
      },
      {
        kind: "cowork",
        from: "2099-07-30",
        to: "2099-07-30",
        entryTier: "open-space",
        date: "2099-07-30",
      },
    ]);
  }));

test("offers the default selection's preloaded prices in structured data", async () =>
  stubWorkspaceInstant(async () => {
    const openSpacePrice = getWorkspaceProductByTier("open-space").price;
    const sale = {
      product: { kind: "cowork" as const, tier: "open-space" as const },
      discountableSubtotal: openSpacePrice,
      discounts: [
        {
          discount: {
            id: Schema.decodeUnknownSync(discountIdSchema)("summer-sale"),
            label: "Summer sale",
            adjustment: { kind: "percentage" as const, basisPoints: 5000 },
          },
          subtotalBefore: openSpacePrice,
          amount: currencyCZK(openSpacePrice.value / 2),
          subtotalAfter: currencyCZK(openSpacePrice.value / 2),
        },
      ],
      totalDiscount: currencyCZK(openSpacePrice.value / 2),
      discountedSubtotal: currencyCZK(openSpacePrice.value / 2),
    };
    const openSpaceOrder = { entryTier: "open-space" as const, coffee: false };
    loadAdvertisedPrices.mockImplementationOnce((requests) =>
      Effect.succeed(
        requests.map((request) => ({
          request,
          advertisedPrice: {
            kind: "cowork",
            quote: buildCoworkReservationQuote(openSpaceOrder, {
              discountQuote: sale,
            }),
            summary: buildCoworkCheckoutSummary(openSpaceOrder, {
              discountQuote: sale,
            }),
            advertisedPriceToken: "sealed",
          },
        }))
      )
    );

    const { form, offerings } = await loadCoworkReservationForm({
      locale: "en-US",
      searchParams: {},
    });
    const markup = renderToString(
      <PublicOfferingsStructuredData locale="en-US" offerings={offerings} />
    );
    const services = JSON.parse(
      markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</script>"))
    )["@graph"];
    const openSpaceAdvertisedPrice = form.initialAdvertisedPrices?.find(
      ({ request }) =>
        request.reservation.kind === "cowork" &&
        request.reservation.details.entryTier === "open-space" &&
        !request.reservation.details.coffee
    )?.advertisedPrice;
    const displayedAmount =
      openSpaceAdvertisedPrice &&
      getAdvertisedProductItem(openSpaceAdvertisedPrice, {
        kind: "cowork",
        tier: "open-space",
      })?.amount;

    expect(markup).toStartWith('<script type="application/ld+json">');
    expect(displayedAmount).toEqual(currencyCZK(openSpacePrice.value / 2));
    expect(services[0]).toMatchObject({
      name: m.reservationOpenSpaceTitle({}, { locale: "en-US" }),
      offers: {
        url: "https://workspace.deskohub.cz/reservation/cowork",
        price: moneyMajorAmount(displayedAmount ?? openSpacePrice),
        priceCurrency: "CZK",
      },
    });
  }));

test("preloads the Prague workspace date's range just before UTC midnight", async () =>
  stubWorkspaceInstant(async () => {
    const form = await renderCoworkReservationForm({
      locale: "en-US",
      searchParams: {},
    });

    // 22:30 UTC is already the next day in Prague (CEST, UTC+2).
    expect(form.today).toBe("2099-07-31");
    expect(form.initialValues?.date).toBe("2099-07-31");
    expect(preloads.availabilityPreloads[0].queries[0]).toEqual({
      kind: "cowork",
      from: "2099-07-31",
      to: "2100-01-31",
      entryTier: "open-space",
    });
    expectPreloadedFormAvailability(form);
  }, "2099-07-30T22:30:00Z"));

test("preloads the selection resolved from reservation query values", async () => {
  const form = await renderCoworkReservationForm({
    locale: "cs-CZ",
    searchParams: {
      entryTier: "reserved-desk",
      coffee: "true",
      date: "2099-08-01",
      monitorOption: "2x27-qhd",
    },
  });

  expect(form.initialValues).toMatchObject({
    entryTier: "reserved-desk",
    coffee: true,
    date: "2099-08-01",
    monitorOption: "2x27-qhd",
    name: "",
    email: "",
    phone: "",
  });

  expect(preloads.advertisedPriceRequests[0]).toEqual(
    everyCoworkPriceRequest("cs-CZ", "2099-08-01")
  );
  expectPreloadedFormAvailability(form);
  expect(preloads.availabilityPreloads[0].queries.slice(1)).toEqual([
    {
      kind: "cowork",
      from: "2099-08-01",
      to: "2099-08-01",
      entryTier: "reserved-desk",
      date: "2099-08-01",
      monitorOption: "2x27-qhd",
    },
    {
      kind: "cowork",
      from: "2099-08-01",
      to: "2099-08-01",
      entryTier: "reserved-desk",
      date: "2099-08-01",
    },
  ]);
});

describe("a linked Entry pack", () => {
  const pack = {
    id: orderIdSchema.make("b53b3c15-9799-45d2-95b5-20f3ef69f3d2"),
    tier: "reserved-desk-workstation" as const,
    entryCount: 5 as const,
    entriesLeft: 3,
    status: "active" as const,
    paidAt: Temporal.Instant.from("2099-07-09T12:00:00Z"),
    validFrom: plainDateStringSchema.make("2099-07-09"),
    validUntil: plainDateStringSchema.make("2099-09-09"),
    claimedDates: [],
    bookedDates: [],
    reservedEntryDates: {},
    giftIssuedAt: null,
    giftClaimedAt: null,
    giftPaymentIsUsable: true,
  } satisfies HeldEntryPack;
  const pageData = {
    entryPackOffered: true,
    bookingPasses: getCoworkBookingPasses([pack], "2099-07-30"),
    passPurchaseOffered: true,
    overnightStayOffered: false,
  };

  test("preselects the linked holder's tier and a workstation setup", async () =>
    stubWorkspaceInstant(async () => {
      const form = await renderCoworkReservationForm({
        locale: "en-US",
        pageData,
        searchParams: { pass: pack.id, tier: "open-space" },
      });
      expect(form.initialValues).toMatchObject({
        entryTier: "reserved-desk",
        initialEntryPack: { kind: "applied", packId: pack.id },
        date: "2099-07-30",
        monitorOption: "2x27-qhd",
      });
    }));

  test("skips an unavailable day for an undated pack link and keeps an explicit date", async () =>
    stubWorkspaceInstant(async () => {
      const date = plainDateStringSchema.make("2099-07-30");
      const coveredPageData = {
        ...pageData,
        bookingPasses: {
          claimedDates: [],
          packs: pageData.bookingPasses.packs.map((bookable) => ({
            ...bookable,
            unavailableDates: [date],
          })),
        },
      };
      const load = (date?: string) =>
        renderCoworkReservationForm({
          locale: "en-US",
          pageData: coveredPageData,
          searchParams: { pass: pack.id, date },
        });

      expect((await load()).initialValues).toMatchObject({
        date: "2099-07-31",
        initialEntryPack: { kind: "applied", packId: pack.id },
      });
      expect((await load(date)).initialValues).toMatchObject({
        date,
        initialEntryPack: { kind: "applied", packId: pack.id },
      });
    }));

  test.each([
    ["another holder", []],
    ["depleted", [{ ...pack, entriesLeft: 0 }]],
    ["unclaimed", [{ ...pack, giftIssuedAt: pack.paidAt }]],
    [
      "refunded",
      [
        {
          ...pack,
          giftIssuedAt: pack.paidAt,
          giftClaimedAt: pack.paidAt,
          giftPaymentIsUsable: false,
        },
      ],
    ],
    [
      "expired at Prague midnight",
      [{ ...pack, validUntil: plainDateStringSchema.make("2099-07-30") }],
    ],
  ])(
    "shows the same invalid-link result when the pack is %s",
    async (_label, heldEntryPacks) =>
      stubWorkspaceInstant(async () => {
        const form = await renderCoworkReservationForm({
          locale: "en-US",
          pageData: {
            ...pageData,
            bookingPasses: getCoworkBookingPasses(heldEntryPacks, "2099-07-30"),
          },
          searchParams: { pass: pack.id },
        });
        expect(form.initialValues.initialEntryPack).toEqual({
          kind: "invalid-link",
        });
        expect(form.initialValues.entryTier).toEqual("open-space");
        expect(JSON.stringify(form.initialValues)).not.toContain(pack.id);
      }, "2099-07-29T22:00:00Z")
  );

  test("preserves an explicit date for the visitor to correct", async () =>
    stubWorkspaceInstant(async () => {
      const form = await renderCoworkReservationForm({
        locale: "en-US",
        pageData,
        searchParams: { pass: pack.id, date: "2099-09-09" },
      });
      expect(form.initialValues.date).toBe("2099-09-09");
      expect(form.initialValues.initialEntryPack?.kind).toBe("applied");
    }));

  test.each([true, false])(
    "restores the last held entry only for an editable claim: %s",
    async (editable) =>
      stubWorkspaceInstant(async () => {
        const date = plainDateStringSchema.make("2099-07-30");
        const reservationId = workspaceReservationIdSchema.make(
          "d38aa11b-02ae-4819-94a9-4ed582be94f6"
        );
        const entryPack = { passId: pack.id, reservationId };
        const form = await renderCoworkReservationForm({
          locale: "en-US",
          pageData: {
            ...pageData,
            bookingPasses: getCoworkBookingPasses(
              [
                {
                  ...pack,
                  entriesLeft: 0,
                  claimedDates: [date],
                  reservedEntryDates: editable ? { [reservationId]: date } : {},
                },
              ],
              date,
              entryPack
            ),
          },
          restoredReservation: {
            entryPack,
            replacementToken: "signed-replacement-token",
            reservation: decodeReservedDeskReservation({
              kind: "cowork",
              name: "Jan Novák",
              email: janEmail,
              phone: "+420712345678",
              billing: defaultReservationBillingSelection,
              entryTier: "reserved-desk",
              coffee: true,
              monitorOption: "2x27-qhd",
              date,
            }),
          },
          searchParams: { pass: "other-pass-id", entryTier: "open-space" },
        });
        if (editable) {
          expect(form.initialValues).toMatchObject({
            initialEntryPack: { kind: "applied", packId: pack.id },
            entryTier: "reserved-desk",
            monitorOption: "2x27-qhd",
            bookingPasses: {
              claimedDates: [],
              packs: [{ id: pack.id, entriesLeft: 1 }],
            },
          });
        } else {
          expect(form.initialValues.initialEntryPack).toEqual({
            kind: "unavailable",
          });
          expect(form.initialValues.bookingPasses.claimedDates).toEqual([date]);
        }
      })
  );
});

describe("a linked overnight stay", () => {
  const overnightLink = {
    entryTier: "reserved-desk",
    date: "2099-08-01",
    stay: "overnight",
  };

  test("opens on the overnight stay and preloads its availability while the release is open", async () => {
    const form = await renderCoworkReservationForm({
      locale: "en-US",
      pageData: {
        entryPackOffered: false,
        bookingPasses: noCoworkBookingPasses,
        passPurchaseOffered: true,
        overnightStayOffered: true,
      },
      searchParams: overnightLink,
    });

    expect(form.initialValues).toMatchObject({
      entryTier: "reserved-desk",
      date: "2099-08-01",
      stay: "overnight",
    });
    expect(preloads.availabilityPreloads[0].queries).not.toHaveLength(0);
    for (const query of preloads.availabilityPreloads[0].queries) {
      expect(query).toMatchObject({ stay: "overnight" });
    }
  });

  test("opens on a day stay while the release is closed", async () => {
    const form = await renderCoworkReservationForm({
      locale: "en-US",
      pageData: {
        entryPackOffered: false,
        bookingPasses: noCoworkBookingPasses,
        passPurchaseOffered: true,
        overnightStayOffered: false,
      },
      searchParams: overnightLink,
    });

    expect(form.initialValues.stay).toBeUndefined();
    for (const query of preloads.availabilityPreloads[0].queries) {
      expect(query).not.toHaveProperty("stay");
    }
  });
});

test("offers the restart state for a legacy basic reservation in en-US", async () => {
  const legacyBasicReservation = decodeLegacyBasicReservation({
    kind: "cowork",
    name: "Jan Novák",
    email: janEmail,
    phone: "+420712345678",
    billing: defaultReservationBillingSelection,
    entryTier: "basic",
    coffee: false,
    date: "2099-08-01",
  });

  const content = await loadCoworkReservationContent({
    locale: "en-US",
    initialReservation: legacyBasicReservation,
    searchParams: {},
  });
  if (content.kind !== "replaced") throw new Error("Expected the restart");
  const markup = renderToString(content.content);

  expect(preloads.availabilityPreloads).toHaveLength(0);
  expect(loadAdvertisedPrices).not.toHaveBeenCalled();
  expect(markup).toContain(
    m.reservationValidationCoworkOfferReplaced({}, { locale: "en-US" })
  );
  expect(markup).toContain(`<a href="/en-US/reservation/cowork"`);
  expect(
    getRestartButtonDirectChildAnchorHref(
      CoworkOfferReplaced({ locale: "en-US" })
    )
  ).toBe("/en-US/reservation/cowork");
});

test("restores a signed current-tier open-space reservation into the form", async () => {
  const restoredOpenSpaceReservation = decodeOpenSpaceReservation({
    kind: "cowork",
    name: "Jan Novák",
    email: janEmail,
    phone: "+420712345678",
    billing: defaultReservationBillingSelection,
    entryTier: "open-space",
    coffee: true,
    date: "2099-08-01",
  });

  const form = await renderCoworkReservationForm({
    locale: "en-US",
    initialReservation: restoredOpenSpaceReservation,
    searchParams: {},
  });

  expect(form.initialValues).toMatchObject({
    entryTier: "open-space",
    coffee: true,
    date: "2099-08-01",
    name: "Jan Novák",
    email: janEmail,
  });
  expect(loadAdvertisedPrices).toHaveBeenCalledTimes(1);
  expect(preloads.advertisedPriceRequests[0]).toEqual(
    everyCoworkPriceRequest("en-US", "2099-08-01")
  );
  expectPreloadedFormAvailability(form);
});

test("reopens the cowork selection edited after returning from Pay with the restored checkout", async () => {
  const restoredReservedDeskReservation = decodeReservedDeskReservation({
    kind: "cowork",
    name: "Jan Novák",
    email: janEmail,
    phone: "+420712345678",
    billing: defaultReservationBillingSelection,
    entryTier: "reserved-desk",
    coffee: true,
    monitorOption: "2x27-qhd",
    date: "2099-08-01",
  });

  const form = await renderCoworkReservationForm({
    locale: "en-US",
    initialReservation: restoredReservedDeskReservation,
    replacementToken: "restored-pay-state",
    searchParams: {
      coffee: "true",
      date: "2099-08-03",
      entryTier: "reserved-desk",
      monitorOption: "none",
      name: "Query Override",
      payState: "restored-pay-state",
    },
  });

  expect(form.initialValues).toMatchObject({
    entryTier: "reserved-desk",
    coffee: true,
    monitorOption: undefined,
    date: "2099-08-03",
    name: "Jan Novák",
    email: janEmail,
  });
  expect(form.replacementToken).toBe("restored-pay-state");
  expect(preloads.advertisedPriceRequests[0]).toEqual(
    everyCoworkPriceRequest("en-US", "2099-08-03")
  );
});

test("restores a signed current-tier reserved-desk reservation into the form", async () => {
  const restoredReservedDeskReservation = decodeReservedDeskReservation({
    kind: "cowork",
    name: "Jan Novák",
    email: janEmail,
    phone: "+420712345678",
    billing: defaultReservationBillingSelection,
    entryTier: "reserved-desk",
    coffee: true,
    monitorOption: "2x27-qhd",
    date: "2099-08-01",
  });

  const form = await renderCoworkReservationForm({
    locale: "en-US",
    initialReservation: restoredReservedDeskReservation,
    searchParams: {},
  });

  expect(form.initialValues).toMatchObject({
    entryTier: "reserved-desk",
    coffee: true,
    monitorOption: "2x27-qhd",
    date: "2099-08-01",
  });
  expect(loadAdvertisedPrices).toHaveBeenCalledTimes(1);
  expect(preloads.advertisedPriceRequests[0]).toEqual(
    everyCoworkPriceRequest("en-US", "2099-08-01")
  );
  expectPreloadedFormAvailability(form);
});

describe("a linked customer's remembered cowork offer", () => {
  const linkedAccount = (
    lastReservation: CustomerLastReservationForKind<"cowork">
  ) =>
    ({
      status: "linked",
      customer: {
        contact: { name: "Jan Novak", email: janEmail, phone: "+420777777777" },
        hasMarketingConsent: false,
        lastReservation,
      },
    }) as const;

  const renderInitialValues = async (
    lastReservation: CustomerLastReservationForKind<"cowork">
  ) => {
    let form: CoworkForm | undefined;
    await stubWorkspaceInstant(async () => {
      form = await renderCoworkReservationForm({
        checkoutAccount: linkedAccount(lastReservation),
        locale: "en-US",
        searchParams: {},
      });
    });
    return form?.initialValues;
  };

  const reservedDeskWithWorkstation = {
    kind: "cowork",
    entryTier: "reserved-desk",
    coffee: true,
    monitorOption: "2x27-qhd",
  } as const;

  test("opens on the remembered offer while it is bookable on the form's date", async () => {
    isRememberedOfferAvailable = true;

    expect(
      await renderInitialValues(reservedDeskWithWorkstation)
    ).toMatchObject({
      date: "2099-07-30",
      entryTier: "reserved-desk",
      monitorOption: "2x27-qhd",
    });
    expect(isRememberedCoworkOfferAvailable).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2099-07-30",
        entryTier: "reserved-desk",
        monitorOption: "2x27-qhd",
      })
    );
  });

  test("opens on the link's selection once the remembered offer is taken", async () => {
    isRememberedOfferAvailable = false;

    expect(
      await renderInitialValues(reservedDeskWithWorkstation)
    ).toMatchObject({
      date: "2099-07-30",
      entryTier: "open-space",
      coffee: false,
    });
    expect(isRememberedCoworkOfferAvailable).toHaveBeenCalledTimes(1);
  });

  test("skips the availability check when the remembered offer matches the link", async () => {
    expect(
      await renderInitialValues({
        kind: "cowork",
        entryTier: "open-space",
        coffee: false,
      })
    ).toMatchObject({ entryTier: "open-space", coffee: false });
    expect(isRememberedCoworkOfferAvailable).not.toHaveBeenCalled();
  });
});
