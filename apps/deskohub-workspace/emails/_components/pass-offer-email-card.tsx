import type { CSSProperties, ReactNode } from "react";
import { Img, Link } from "react-email";
import { type Locale, m } from "@/features/i18n";
import { getWorkspacePageUrl } from "@/features/i18n/page-url";
import {
  type EntryPackSize,
  type PassProduct,
  unlimitedPassDays,
} from "@/features/passes/pass-offer";
import {
  entryPackCheckoutPath,
  unlimitedPassCheckoutPath,
} from "@/features/passes/routes";
import {
  getWorkspaceCanonicalUrl,
  workspaceSiteConstants,
} from "@/shared/utils";
import { EmailArrowBadge } from "./email-arrow-badge";

const ticketMarkUrl = getWorkspaceCanonicalUrl(
  "/email/entry-pack-ticket-mark.png"
);
const credentialUrl = getWorkspaceCanonicalUrl(
  "/email/unlimited-pass-credential.png"
);

const fontFamily = "Arial, Helvetica, sans-serif";

const presentationTable = {
  border: 0,
  cellPadding: 0,
  cellSpacing: 0,
  role: "presentation",
} as const;

type PassOfferCopy = {
  readonly name: string;
  /** The card's lead line: the campaign's saving, else the product's benefit. */
  readonly headline: string;
  readonly detail?: string | undefined;
};

/**
 * A card cell: the cell's table and its share of the card link. Classic
 * Outlook ignores a link around a table, so each cell links its own content.
 * The link fills its cell, padding included, even beside a taller cell: the
 * cell's nominal height lets the link's percentage height resolve, and the
 * link lays out as a table so its content stays vertically centred.
 */
function LinkedCell({
  align,
  children,
  color,
  colSpan,
  href,
  padding,
  decorative = false,
  style,
  width,
}: {
  readonly align?: "center" | "right";
  readonly children: ReactNode;
  readonly color: string;
  readonly colSpan?: number;
  readonly href: string;
  readonly padding: string;
  /**
   * A decorative cell's link only widens the card's click area: it stays out
   * of plain text, the tab order, and assistive technology, so the text
   * cell's link is the card's one named link.
   */
  readonly decorative?: boolean;
  /** The cell's own style, such as the ticket's perforation. */
  readonly style?: CSSProperties;
  readonly width?: number;
}) {
  return (
    <td
      align={align}
      colSpan={colSpan}
      style={{ height: 1, ...(width && { width }), ...style }}
      valign="middle"
      width={width}
    >
      <Link
        aria-hidden={decorative ? "true" : undefined}
        data-skip-in-text={decorative ? "true" : undefined}
        href={href}
        style={{
          color,
          display: "table",
          height: "100%",
          textDecoration: "none",
          width: "100%",
        }}
        tabIndex={decorative ? -1 : undefined}
      >
        <span
          style={{
            display: "table-cell",
            padding,
            textAlign: align ?? "left",
            verticalAlign: "middle",
          }}
        >
          {children}
        </span>
      </Link>
    </td>
  );
}

/**
 * The product name, lead line, and detail line, as a linked cell. The lines
 * are inline text split by line breaks, which Outlook keeps inside the link
 * and plain text keeps as lines; each line's height sets its spacing.
 */
function PassOfferTextCell({
  color,
  copy,
  detailColor,
  href,
  padding,
}: {
  readonly color: string;
  readonly copy: PassOfferCopy;
  readonly detailColor: string;
  readonly href: string;
  readonly padding: string;
}) {
  return (
    <LinkedCell color={color} href={href} padding={padding}>
      <span
        style={{
          display: "block",
          fontSize: 0,
          lineHeight: 0,
          textWrap: "balance",
        }}
      >
        <span
          style={{
            color,
            fontFamily,
            fontSize: 14.5,
            fontWeight: 700,
            lineHeight: "19px",
          }}
        >
          {copy.name}
        </span>
        <br />
        <span
          style={{
            color,
            fontFamily,
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: -0.4,
            lineHeight: "31px",
          }}
        >
          {copy.headline}
        </span>
        {copy.detail && (
          <>
            <br />
            <span
              style={{
                color: detailColor,
                fontFamily,
                fontSize: 13,
                lineHeight: "22px",
              }}
            >
              {copy.detail}
            </span>
          </>
        )}
      </span>
    </LinkedCell>
  );
}

/**
 * The Entry pack as a golden perforated admission ticket: the body carries the
 * text, the tear-off stub the arrow. Gold stands in where gradients and the
 * logo watermark don't render.
 */
function EntryPackTicket({
  copy,
  href,
}: {
  readonly copy: PassOfferCopy;
  readonly href: string;
}) {
  const ink = "#5b2407";
  return (
    <table
      {...presentationTable}
      bgcolor="#f9cb70"
      style={{
        backgroundColor: "#f9cb70",
        backgroundImage: `url('${ticketMarkUrl}'), linear-gradient(105deg, #ffe2a4 5%, #f9cb70 71%, #ebb25a)`,
        backgroundPosition: "right top, 0 0",
        backgroundRepeat: "no-repeat, no-repeat",
        backgroundSize: "191px auto, auto",
        borderCollapse: "separate",
        borderRadius: 14,
        marginTop: 22,
        width: "100%",
      }}
      width="100%"
    >
      <tbody>
        <tr>
          {/* The ticket's edge stripe, a cell so the card link covers it. */}
          <LinkedCell
            color={ink}
            href={href}
            padding="0"
            decorative
            style={{
              backgroundColor: "#a43810",
              borderRadius: "14px 0 0 14px",
            }}
            width={4}
          >
            {null}
          </LinkedCell>
          <PassOfferTextCell
            color={ink}
            copy={copy}
            detailColor="#6b3410"
            href={href}
            padding="15px 16px 15px 18px"
          />
          <LinkedCell
            align="center"
            color={ink}
            href={href}
            padding="14px 8px"
            decorative
            style={{ borderLeft: "1.5px dashed #9a4a1c" }}
            width={64}
          >
            <EmailArrowBadge background="#652607" color="#fff2d4" />
          </LinkedCell>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The Unlimited pass as a burgundy Workspace ID card: issuer line and foil
 * stripe on top, the logo as the holder's portrait, the arrow on the right.
 * Burgundy stands in where gradients don't render; the portrait is decoration.
 */
function UnlimitedPassCard({
  copy,
  href,
}: {
  readonly copy: PassOfferCopy;
  readonly href: string;
}) {
  const ink = "#fff6f8";
  return (
    <table
      {...presentationTable}
      bgcolor="#761730"
      style={{
        backgroundColor: "#761730",
        backgroundImage:
          "radial-gradient(ellipse at 100% 0%, #942941 0%, transparent 58%), linear-gradient(158deg, #83223a 5%, #761730 85%)",
        border: "1px solid #b06c7d",
        borderCollapse: "separate",
        borderRadius: 14,
        marginTop: 22,
        width: "100%",
      }}
      width="100%"
    >
      <tbody>
        <tr>
          <LinkedCell
            color={ink}
            colSpan={3}
            href={href}
            padding="12px 22px 0 18px"
            decorative
          >
            <table
              {...presentationTable}
              style={{ width: "100%" }}
              width="100%"
            >
              <tbody>
                <tr>
                  <td
                    style={{
                      color: "#fae8ee",
                      fontFamily,
                      fontSize: 11,
                      fontWeight: 700,
                      lineHeight: "13px",
                      paddingRight: 8,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {workspaceSiteConstants.brand.name}
                  </td>
                  <td style={{ width: "100%" }} valign="middle">
                    <div
                      style={{
                        borderTop: "1px solid #a4536a",
                        fontSize: 0,
                        lineHeight: 0,
                      }}
                    />
                  </td>
                  <td style={{ paddingLeft: 8 }} valign="middle">
                    <div
                      style={{
                        backgroundColor: "#ffc2cc",
                        backgroundImage:
                          "linear-gradient(105deg, #ffc2cc 0%, #d999bf 55%, #f3d9c6 100%)",
                        borderRadius: 2,
                        fontSize: 0,
                        height: 4,
                        lineHeight: 0,
                        width: 28,
                      }}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </LinkedCell>
        </tr>
        <tr>
          <LinkedCell
            color={ink}
            href={href}
            padding="10px 0 15px 18px"
            decorative
            width={68}
          >
            <Img
              alt=""
              height={58}
              src={credentialUrl}
              style={{ display: "block" }}
              width={50}
            />
          </LinkedCell>
          <PassOfferTextCell
            color={ink}
            copy={copy}
            detailColor="#f6dce4"
            href={href}
            padding="10px 14px 15px"
          />
          <LinkedCell
            align="right"
            color={ink}
            href={href}
            padding="10px 22px 15px 0"
            decorative
            width={52}
          >
            <EmailArrowBadge background="#ffdae6" color="#761730" />
          </LinkedCell>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * A pass product as a clickable card that opens its purchase page in the
 * reader's language; an Entry pack card may open it on one pack size.
 * `headline` and `detail` are the campaign's own words, such as a saving;
 * without a headline the card leads with the product's benefit. Everything
 * the card says stays text, so it reads without images or styles, and plain
 * text keeps the product, its lines, and one link.
 */
export function PassOfferEmailCard({
  detail,
  headline,
  locale,
  product,
  size,
}: {
  readonly detail?: string | undefined;
  readonly headline?: string | undefined;
  readonly locale: Locale;
  readonly product: PassProduct["kind"];
  readonly size?: EntryPackSize | undefined;
}) {
  if (product === "entry-pack") {
    return (
      <EntryPackTicket
        copy={{
          name: m.passEntryPack({}, { locale }),
          headline:
            headline || m.emailPassOfferEntryPackBenefit({}, { locale }),
          detail,
        }}
        href={getWorkspacePageUrl(
          entryPackCheckoutPath,
          size === undefined ? undefined : { size: String(size) }
        )}
      />
    );
  }
  return (
    <UnlimitedPassCard
      copy={{
        name: m.passUnlimited({}, { locale }),
        headline:
          headline ||
          m.emailPassOfferUnlimitedBenefit(
            { count: unlimitedPassDays },
            { locale }
          ),
        detail,
      }}
      href={getWorkspacePageUrl(unlimitedPassCheckoutPath)}
    />
  );
}
