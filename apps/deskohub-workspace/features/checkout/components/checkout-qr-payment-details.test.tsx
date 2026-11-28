import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutQrPaymentDetails } from "./checkout-qr-payment-details";

test("QR checkout shows payment instructions and manual transfer details", () => {
  const html = renderToStaticMarkup(
    <CheckoutQrPaymentDetails
      locale="en-US"
      payment={{
        accountNumber: "19-2000145399/0800",
        amount: "CZK 450.50",
        deadline: "Nov 19, 2026, 3:30 PM",
        expiresAt: "2026-11-19T14:30:00Z",
        qrCodeSource: "data:image/png;base64,iVBORw0KGgo=",
        variableSymbol: "0012345678",
      }}
    />
  );

  expect(html).toContain('alt="Bank transfer QR code"');
  expect(html).toContain("Scan the QR code in your banking app");
  expect(html).toContain("<dl");
  expect(html).toContain("CZK 450.50");
  expect(html).toContain("19-2000145399/0800");
  expect(html).toContain("0012345678");
  expect(html).toMatch(/<time datetime="2026-11-19T14:30:00Z">/i);
  expect(html).toContain("Nov 19, 2026, 3:30 PM");
});
