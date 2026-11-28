import assert from "node:assert/strict";

export const openTestPaymentWindow = (): Window => {
  const paymentWindow = window.open("about:blank", "_blank");
  assert(paymentWindow, "Test payment window did not open");
  // Happy DOM exposes opener as read-only. The browser allows detaching it.
  Object.defineProperty(paymentWindow, "opener", {
    configurable: true,
    writable: true,
    value: window,
  });
  return paymentWindow;
};
