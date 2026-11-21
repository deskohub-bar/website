import { addRedaction } from "../redaction";

export const readMockHostedPaymentUrl = (
  value: string,
  previewOrigins: readonly string[]
): URL | undefined => {
  const url = URL.parse(value);
  return url?.pathname === "/api/checkout/mock-payment" &&
    previewOrigins.includes(url.origin)
    ? url
    : undefined;
};

export const addMockPaymentUrlRedactions = (url: URL) => {
  addRedaction(url.searchParams.get("paymentId") ?? undefined);
  addRedaction(url.searchParams.get("token") ?? undefined);
};
