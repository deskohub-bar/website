import { type Layer, Schema } from "effect";
import type { WorkspaceDatabase } from "@/db/database.service";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import type { DescribedAgentTool } from "./agent-interfaces-markdown";
import {
  listPassesTool,
  showPassAccessTool,
  startPassPurchaseTool,
} from "./agent-pass-tools";
import {
  type AgentTool,
  type CallableAgentTools,
  hasAgentToolArgument,
} from "./agent-tool";
import type { AgentToolClient } from "./agent-tool-client";
import { getToolCalls } from "./agent-tool-mcp-authorization";
import type { McpRequest } from "./agent-tool-mcp-messages";
import { checkAvailabilityTool } from "./check-availability.tool";
import type { SignedInAgentToolRequirements } from "./customer-agent-caller";
import type { CustomerAgentToolsLive } from "./customer-agent-tools";
import { getOrdinaryQuoteTool, getQuoteTool } from "./get-quote.tool";
import { getReservationStatusTool } from "./get-reservation-status.tool";
import { listMyReservationsTool } from "./list-my-reservations.tool";
import { listOfferingsTool } from "./list-offerings.tool";
import { passFundingScope, withoutPassFunding } from "./pass-funding";
import { makeShowBookingTool } from "./show-booking.tool";
import {
  startOrdinaryReservationTool,
  startReservationTool,
} from "./start-reservation.tool";
import { startReservationOnWebsiteTool } from "./start-reservation-on-website.tool";

type CustomerAgentTool = AgentTool<
  | Layer.Success<typeof CustomerAgentToolsLive>
  | SignedInAgentToolRequirements
  | WorkspaceDatabase
  | CallableAgentTools
>;

/**
 * What one client is served: its customer tools in order, and the
 * instructions for them.
 */
interface CustomerAgentListing {
  readonly tools: ReadonlyArray<CustomerAgentTool>;
  readonly instructions: string;
}

const startReservationOnWebsite = withoutPassFunding(
  startReservationOnWebsiteTool
);

/**
 * Whether the client's directory admits links that start a checkout and
 * copy about paying. ChatGPT's admits commerce only for physical goods, so
 * its customers finish on the prefilled reservation page instead.
 */
const admitsCheckout = (client: AgentToolClient) => client !== "chatgpt";

/**
 * The customer tools, in the order agents see them. Every client sees every
 * tool; where the client's directory admits no checkout, `start_reservation`
 * books nothing and links the prefilled reservation page instead, and the
 * booking view never starts a booking.
 */
const listCustomerAgentTools = (
  checkout: boolean,
  passes: boolean
): ReadonlyArray<CustomerAgentTool> => {
  const startReservation = passes
    ? startReservationTool
    : startOrdinaryReservationTool;
  return [
    listOfferingsTool,
    checkAvailabilityTool,
    passes && checkout ? getQuoteTool : getOrdinaryQuoteTool,
    makeShowBookingTool({ admitsCheckout: checkout }),
    checkout ? startReservation : startReservationOnWebsite,
    getReservationStatusTool,
    listMyReservationsTool,
    ...(passes ? [listPassesTool, showPassAccessTool] : []),
    ...(passes && checkout ? [startPassPurchaseTool] : []),
  ];
};

const { brand, location, openingHours } = workspaceSiteConstants;
const { address } = location;

/** What the business is, for agents, from the site constants. */
const businessSummary = `${brand.name} is a coworking space at ${address.street}, ${address.postalCode} ${address.city}${openingHours.alwaysOpen ? ", open 24/7" : ""}.`;

/** Whether the listing holds a tool of each of these names. */
const listsEvery = (
  tools: ReadonlyArray<CustomerAgentTool>,
  names: ReadonlyArray<string>
) => names.every((name) => tools.some((tool) => tool.name === name));

/**
 * How booking works and what agents can't do, for the tools a client sees.
 * Where the client's directory admits no checkout, nothing mentions paying.
 * Each sentence about a customer tool appears only when the client sees
 * that tool.
 */
const getBookingGuidance = (
  checkout: boolean,
  tools: ReadonlyArray<CustomerAgentTool>
): ReadonlyArray<string> => {
  const startReservation = tools.find(
    ({ name }) => name === startReservationTool.name
  );
  const readsReservations = listsEvery(tools, [
    getReservationStatusTool.name,
    listMyReservationsTool.name,
  ]);

  return [
    checkout
      ? "Bookings are made and paid on the website: give the customer the reservation_url from a result to finish there. Availability and price are confirmed on the website before payment."
      : "Customers book on the website, which confirms availability and the price: give the customer the reservation_url from a result to finish there.",
    ...(startReservation === undefined
      ? []
      : [
          startReservation.readOnly
            ? "start_reservation returns the reservation page for a complete selection, filled in, where the customer finishes the booking; it books nothing itself."
            : "With the customer signed in, start_reservation holds a selection for them and returns a pay_url where they accept the terms and pay.",
        ]),
    ...(readsReservations
      ? [
          "With the customer signed in, get_reservation_status and list_my_reservations show their own reservations.",
          checkout
            ? "The customer tools can't pay for, cancel, or change a reservation."
            : "The customer tools can't cancel or change a reservation.",
        ]
      : []),
  ];
};

/**
 * The server instructions for the tools a client sees. The products come
 * from list_offerings, so the instructions don't repeat the catalog.
 */
const getServerInstructions = (
  checkout: boolean,
  tools: ReadonlyArray<CustomerAgentTool>
) =>
  [
    businessSummary,
    ...(listsEvery(tools, [
      listOfferingsTool.name,
      checkAvailabilityTool.name,
      getQuoteTool.name,
    ])
      ? [
          "Use list_offerings for the products on offer with their regular price and today's price including any public sale, check_availability to see whether a selection looks free, and get_quote for the exact price of a selection.",
        ]
      : []),
    ...getBookingGuidance(checkout, tools),
    ...(listsEvery(tools, [listPassesTool.name, showPassAccessTool.name])
      ? [
          "Use list_passes for the signed-in customer's cowork passes, and show_pass_access for the link to their Unlimited access page.",
        ]
      : []),
    ...(listsEvery(tools, [startPassPurchaseTool.name])
      ? [
          "Use an entry pack's pass_id to quote or start a cowork booking with an entry. Use start_pass_purchase to prepare a pass checkout. Give the customer the pay_url to accept the terms and pay on the website, or the status_url if payment has already started.",
        ]
      : []),
  ].join(" ");

const makeListing = (
  checkout: boolean,
  passes: boolean
): CustomerAgentListing => {
  const tools = listCustomerAgentTools(checkout, passes);
  return { tools, instructions: getServerInstructions(checkout, tools) };
};

const checkoutListing = makeListing(true, false);
const websiteHandoffListing = makeListing(false, false);
const passCheckoutListing = makeListing(true, true);
const passWebsiteHandoffListing = makeListing(false, true);

const passToolNames = new Set([
  listPassesTool.name,
  showPassAccessTool.name,
  startPassPurchaseTool.name,
]);

const isCatalogDiscovery = Schema.is(
  Schema.Struct({ method: Schema.Literals(["initialize", "tools/list"]) })
);

/** Ordinary tool calls need no pass release decision. */
export const needsAgentPassCatalog = ({ messages }: McpRequest) =>
  messages.some(isCatalogDiscovery) ||
  getToolCalls(messages).some(
    ({ params: { name, arguments: args } }) =>
      passToolNames.has(name) ||
      hasAgentToolArgument(args, passFundingScope.argument)
  );

/**
 * What the customer MCP server (`/api/mcp`) serves each client, and what
 * llms.txt describes: the public tools to anyone, the signed-in tools,
 * including starting a booking, to agents with an OAuth access token, and
 * the server instructions for them. Tools served beside the customer tools,
 * such as administration tools, are added after these, untouched.
 */
export const customerAgentCatalog: {
  /** What one client is served. */
  readonly forClient: (
    client: AgentToolClient,
    passes?: boolean
  ) => CustomerAgentListing;
  /**
   * What llms.txt describes: the tools as a client whose directory admits
   * checkout sees them, and the booking guidance that client is given.
   */
  readonly published: {
    readonly tools: ReadonlyArray<DescribedAgentTool>;
    readonly guidance: string;
  };
} = {
  forClient: (client, passes = false) => {
    if (admitsCheckout(client))
      return passes ? passCheckoutListing : checkoutListing;
    return passes ? passWebsiteHandoffListing : websiteHandoffListing;
  },
  published: {
    tools: checkoutListing.tools,
    guidance: getBookingGuidance(true, checkoutListing.tools).join(" "),
  },
};
