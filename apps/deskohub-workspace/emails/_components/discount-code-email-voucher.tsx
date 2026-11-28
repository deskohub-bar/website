import { Img, Link, Text } from "react-email";
import { getWorkspaceCanonicalUrl } from "@/shared/utils";
import { EmailArrowBadge } from "./email-arrow-badge";

const cueArrowUrl = getWorkspaceCanonicalUrl("/email/offer-cue-arrow.png");

const voucherTextStyle = {
  fontFamily: "Arial, Helvetica, sans-serif",
  textWrap: "balance",
} as const;

/**
 * A recipient's discount code as a mint-edge voucher that books with it: the
 * whole voucher links to the booking, and a handwritten cue below links there
 * too. Solid colours stand in where gradients don't render, and the code,
 * validity, and cue stay text, so they read with styles and images stripped.
 */
export function DiscountCodeEmailVoucher({
  code,
  codeLabel,
  cue,
  href,
  validity,
}: {
  readonly code: string;
  readonly codeLabel: string;
  /** The booking call to action, such as “Book with 25% off”. */
  readonly cue: string;
  readonly href: string;
  readonly validity: string;
}) {
  return (
    <>
      <Link
        href={href}
        style={{
          color: "#00024f",
          display: "block",
          marginTop: 24,
          textDecoration: "none",
        }}
      >
        <table
          bgcolor="#dcfbef"
          border={0}
          cellPadding={0}
          cellSpacing={0}
          role="presentation"
          style={{
            backgroundColor: "#dcfbef",
            backgroundImage:
              "linear-gradient(180deg, #dcfbef 0%, #c6f6e2 100%)",
            borderBottom: "4px solid #006b55",
            borderCollapse: "separate",
            borderLeft: "6px solid #00df99",
            borderRadius: 16,
            borderRight: "1px solid #00a876",
            borderTop: "1px solid #00a876",
            width: "100%",
          }}
          width="100%"
        >
          <tbody>
            <tr>
              <td style={{ padding: "18px 20px 16px" }}>
                <Text
                  className="m-0 text-[12px] font-bold uppercase leading-[16px] tracking-[0.72px] text-[#004e3e]"
                  style={voucherTextStyle}
                >
                  {codeLabel}
                </Text>
                <table
                  border={0}
                  cellPadding={0}
                  cellSpacing={0}
                  role="presentation"
                  style={{ marginTop: 12, width: "100%" }}
                  width="100%"
                >
                  <tbody>
                    <tr>
                      <td
                        align="center"
                        style={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #8bdac0",
                          borderRadius: 10,
                          color: "#00024f",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
                          fontSize: 22,
                          fontWeight: 700,
                          letterSpacing: 2,
                          lineHeight: "30px",
                          padding: "12px 14px",
                          textAlign: "center",
                          wordBreak: "break-all",
                        }}
                      >
                        {code}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <table
                  border={0}
                  cellPadding={0}
                  cellSpacing={0}
                  role="presentation"
                  style={{ marginTop: 11, width: "100%" }}
                  width="100%"
                >
                  <tbody>
                    <tr>
                      <td valign="middle">
                        <Text
                          className="m-0 text-[13px] font-bold leading-[19px] text-[#13473b]"
                          style={voucherTextStyle}
                        >
                          {validity}
                        </Text>
                      </td>
                      <td
                        align="right"
                        style={{ paddingLeft: 12 }}
                        valign="middle"
                        width={30}
                      >
                        <EmailArrowBadge background="#006b55" color="#ffffff" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </Link>
      <table
        align="center"
        border={0}
        cellPadding={0}
        cellSpacing={0}
        role="presentation"
        style={{ marginTop: 6 }}
      >
        <tbody>
          <tr>
            <td style={{ paddingBottom: 2 }} valign="bottom">
              <Link
                href={href}
                style={{
                  color: "#006b55",
                  display: "inline-block",
                  fontFamily:
                    "Caveat, 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive",
                  fontSize: 26,
                  fontWeight: 700,
                  lineHeight: "28px",
                  textDecoration: "none",
                  transform: "rotate(-2deg)",
                }}
              >
                {cue}
              </Link>
            </td>
            <td style={{ paddingLeft: 6 }} valign="bottom" width={56}>
              <Img
                alt=""
                height={44}
                src={cueArrowUrl}
                style={{ display: "block" }}
                width={56}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
