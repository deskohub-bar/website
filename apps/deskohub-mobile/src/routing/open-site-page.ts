import {
  openBrowserAsync,
  type WebBrowserResult,
  type WebBrowserResultType,
} from "expo-web-browser";
import { Platform } from "react-native";
import { color } from "../ui/tokens";

/**
 * The in-app browser tab coloured like the app: the paper canvas with navy
 * controls. Site pages and the payment page open in it.
 */
export const appBrowserTabColors = {
  toolbarColor: color.paper,
  controlsColor: color.navy,
  secondaryToolbarColor: color.paper,
} as const;

/**
 * Opens a site page in the in-app browser tab, coloured like the app, with
 * the page's title above its host in the toolbar (board 16b); on the web,
 * in a new tab. It fails where no browser is available. A caller that tells
 * the customer when the page didn't open passes `failIfBlocked`, and it
 * also fails when a web browser blocks the tab, which Expo's web opener
 * reports as opened.
 */
export const openSitePage = async (
  url: string,
  { failIfBlocked = false }: { readonly failIfBlocked?: boolean } = {}
): Promise<WebBrowserResult> => {
  if (Platform.OS !== "web" || !failIfBlocked)
    return openBrowserAsync(url, { ...appBrowserTabColors, showTitle: true });
  const page = window.open(url, "_blank");
  if (page === null) throw new Error("The browser blocked the page.");
  page.opener = null;
  return { type: "opened" as WebBrowserResultType.OPENED };
};
