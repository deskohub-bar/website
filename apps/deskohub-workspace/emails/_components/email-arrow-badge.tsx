/**
 * The right-pointing arrow in a circle that marks a card as a link. It is
 * text, not an image, so it shows while images are blocked; Outlook draws it
 * as a highlighted arrow. Plain text leaves it out: the card's link already
 * reads there.
 */
export const EmailArrowBadge = ({
  background,
  color,
}: {
  readonly background: string;
  readonly color: string;
}) => (
  <span
    data-skip-in-text="true"
    style={{
      backgroundColor: background,
      borderRadius: 999,
      color,
      display: "inline-block",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: 17,
      fontWeight: 700,
      height: 30,
      lineHeight: "30px",
      textAlign: "center",
      textDecoration: "none",
      verticalAlign: "middle",
      width: 30,
    }}
  >
    {"→"}
  </span>
);
