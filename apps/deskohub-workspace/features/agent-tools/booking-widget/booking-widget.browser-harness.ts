import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  AppBridge,
  type McpUiHostContext,
  type McpUiStyles,
  type McpUiTheme,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Schema } from "effect";

/** The host context fields the view reads. */
type BookingHostSettings = {
  readonly locale?: string;
  readonly theme?: McpUiTheme;
  /** Hosts send only the style variables they define. */
  readonly styleVariables?: Partial<McpUiStyles>;
};

/** What the test hands the host page before this script runs. */
type BookingHarness = {
  /** The built view, as `resources/read` serves it. */
  readonly html: string;
  readonly host: BookingHostSettings;
  /** Whether the host declares `openLinks`. */
  readonly opensLinks: boolean;
  readonly toolArguments: Schema.JsonObject;
  readonly toolResult: CallToolResult;
};

declare global {
  interface Window {
    readonly bookingHarness: BookingHarness;
    /** Answers the view's `tools/call`; the test exposes it. */
    readonly callBookingTool: (
      name: string,
      args: Schema.JsonObject
    ) => Promise<CallToolResult>;
    /** Records the view's `ui/open-link`; the test exposes it. */
    readonly openBookingLink: (url: string) => Promise<void>;
    /** Records the view's `window.openai.openExternal`; the test exposes it. */
    readonly openBookingExternal: NonNullable<Window["openai"]>["openExternal"];
    /** Changes the host context, as a host does when its theme changes. */
    readonly changeBookingHost: (changes: BookingHostSettings) => void;
  }
}

// A minimal MCP Apps host: the view runs in a sandboxed frame without the
// page's origin, as hosts run it, and talks to the host over postMessage.
const { html, host, opensLinks, toolArguments, toolResult } =
  window.bookingHarness;

const decodeToolArguments = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Json)
);

// The spec's type lists every style variable, though hosts send a subset:
// the view applies only the ones that have a value.
const unsetStyleVariables: McpUiStyles = {
  "--color-background-primary": undefined,
  "--color-background-secondary": undefined,
  "--color-background-tertiary": undefined,
  "--color-background-inverse": undefined,
  "--color-background-ghost": undefined,
  "--color-background-info": undefined,
  "--color-background-danger": undefined,
  "--color-background-success": undefined,
  "--color-background-warning": undefined,
  "--color-background-disabled": undefined,
  "--color-text-primary": undefined,
  "--color-text-secondary": undefined,
  "--color-text-tertiary": undefined,
  "--color-text-inverse": undefined,
  "--color-text-ghost": undefined,
  "--color-text-info": undefined,
  "--color-text-danger": undefined,
  "--color-text-success": undefined,
  "--color-text-warning": undefined,
  "--color-text-disabled": undefined,
  "--color-border-primary": undefined,
  "--color-border-secondary": undefined,
  "--color-border-tertiary": undefined,
  "--color-border-inverse": undefined,
  "--color-border-ghost": undefined,
  "--color-border-info": undefined,
  "--color-border-danger": undefined,
  "--color-border-success": undefined,
  "--color-border-warning": undefined,
  "--color-border-disabled": undefined,
  "--color-ring-primary": undefined,
  "--color-ring-secondary": undefined,
  "--color-ring-inverse": undefined,
  "--color-ring-info": undefined,
  "--color-ring-danger": undefined,
  "--color-ring-success": undefined,
  "--color-ring-warning": undefined,
  "--font-sans": undefined,
  "--font-mono": undefined,
  "--font-weight-normal": undefined,
  "--font-weight-medium": undefined,
  "--font-weight-semibold": undefined,
  "--font-weight-bold": undefined,
  "--font-text-xs-size": undefined,
  "--font-text-sm-size": undefined,
  "--font-text-md-size": undefined,
  "--font-text-lg-size": undefined,
  "--font-heading-xs-size": undefined,
  "--font-heading-sm-size": undefined,
  "--font-heading-md-size": undefined,
  "--font-heading-lg-size": undefined,
  "--font-heading-xl-size": undefined,
  "--font-heading-2xl-size": undefined,
  "--font-heading-3xl-size": undefined,
  "--font-text-xs-line-height": undefined,
  "--font-text-sm-line-height": undefined,
  "--font-text-md-line-height": undefined,
  "--font-text-lg-line-height": undefined,
  "--font-heading-xs-line-height": undefined,
  "--font-heading-sm-line-height": undefined,
  "--font-heading-md-line-height": undefined,
  "--font-heading-lg-line-height": undefined,
  "--font-heading-xl-line-height": undefined,
  "--font-heading-2xl-line-height": undefined,
  "--font-heading-3xl-line-height": undefined,
  "--border-radius-xs": undefined,
  "--border-radius-sm": undefined,
  "--border-radius-md": undefined,
  "--border-radius-lg": undefined,
  "--border-radius-xl": undefined,
  "--border-radius-full": undefined,
  "--border-width-regular": undefined,
  "--shadow-hairline": undefined,
  "--shadow-sm": undefined,
  "--shadow-md": undefined,
  "--shadow-lg": undefined,
};

const toHostContext = ({
  styleVariables,
  ...context
}: BookingHostSettings): McpUiHostContext => ({
  ...context,
  ...(styleVariables && {
    styles: { variables: { ...unsetStyleVariables, ...styleVariables } },
  }),
});
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", "allow-scripts");
frame.title = "Booking view";
frame.style.cssText = "width: 100%; height: 400px; border: 0; display: block";
document.body.append(frame);

const view = frame.contentWindow;
if (view) {
  const bridge = new AppBridge(
    null,
    { name: "booking-harness", version: "1.0.0" },
    { serverTools: {}, ...(opensLinks && { openLinks: {} }) },
    { hostContext: toHostContext(host) }
  );
  bridge.oncalltool = ({ name, arguments: args = {} }) =>
    window.callBookingTool(name, decodeToolArguments(args));
  bridge.onopenlink = async ({ url }) => {
    await window.openBookingLink(url);
    return {};
  };
  bridge.onsizechange = ({ height }) => {
    if (height !== undefined) frame.style.height = `${height}px`;
  };
  bridge.oninitialized = () => {
    void bridge
      .sendToolInput({ arguments: toolArguments })
      .then(() => bridge.sendToolResult(toolResult));
  };
  let settings = host;
  Object.assign(window, {
    changeBookingHost: (changes: BookingHostSettings) => {
      settings = { ...settings, ...changes };
      bridge.setHostContext(toHostContext(settings));
    },
  });
  void bridge.connect(new PostMessageTransport(view, view));
  frame.srcdoc = html;
}
