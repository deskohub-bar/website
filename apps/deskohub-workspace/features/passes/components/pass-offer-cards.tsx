import Interpolate from "@doist/react-interpolate";
import type { CSSProperties, ReactNode } from "react";
import workspaceMark from "@/assets/logo/small-bg:dark.svg";
import { type Locale, m } from "@/features/i18n";
import { cn, type VariableStyle } from "@/shared/utils";
import { entryPackOffers, type PassTier } from "../pass-offer";
import { formatPassDate, getPassTierName } from "../pass-offer.i18n";

type PassOfferCardProps = {
  /** The purchase page, carrying the customer's draft. */
  readonly href: string;
  readonly locale: Locale;
  readonly tier: PassTier;
};

const entryPackSizes = entryPackOffers.map(({ product }) => product.size);
const smallerEntryPack = Math.min(...entryPackSizes);
const largerEntryPack = Math.max(...entryPackSizes);

const markMask = `url("${workspaceMark.src}") center / contain no-repeat`;

/** Cuts the round notches of a ticket's tear-off seam. */
const notchMask = ({
  fold,
  top,
  bottom,
  radius,
}: Record<"fold" | "top" | "bottom" | "radius", string>) => {
  const notch = (at: string) =>
    `radial-gradient(circle at ${fold} ${at}, transparent calc(${radius} - .35px), black ${radius})`;
  const mask = `${notch(top)}, ${notch(bottom)}`;
  return {
    maskImage: mask,
    WebkitMaskImage: mask,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
  } satisfies CSSProperties;
};

/**
 * The Entry pack's Workspace watermark: one half of the mark on each side of
 * the seam, darkening the ticket body and softly lighting the stub.
 */
const watermarkHalf = {
  position: "absolute",
  insetInlineStart: "calc(var(--fold) - var(--seam-from-mark-start))",
  insetBlockEnd:
    "calc(-15px + .493 * (var(--old-mark-size) - var(--mark-size)))",
  inlineSize: "var(--mark-size)",
  aspectRatio: "1",
  mask: markMask,
  WebkitMask: markMask,
} satisfies CSSProperties;

/** The Entry pack ticket face: its seam, fold shading, and watermark sizes. */
const entryPackTicketFace: VariableStyle<
  "old-mark-size" | "mark-size" | "seam-from-mark-start" | "fold"
> = {
  "--old-mark-size": "clamp(85px, 37cqi, 152px)",
  "--mark-size": "calc((21px + .771 * var(--old-mark-size)) / .2725)",
  "--seam-from-mark-start":
    "calc(5px + .771 * var(--old-mark-size) + .229 * var(--mark-size))",
  "--fold": "calc(100% - max(82px, 27%) + 1px)",
  background:
    "linear-gradient(90deg, #a43810 0 4px, #fff5e9 4px var(--fold), #fae7d1 var(--fold) 100%)",
  ...notchMask({
    fold: "var(--fold)",
    top: "-1px",
    bottom: "calc(100% + 1px)",
    radius: "10px",
  }),
};

function PassOfferLink({
  "aria-describedby": describedBy,
  children,
  href,
  label,
}: {
  readonly "aria-describedby"?: string;
  readonly children: ReactNode;
  readonly href: string;
  readonly label: string;
}) {
  return (
    <a
      aria-describedby={describedBy}
      aria-label={label}
      className="group grid min-w-0 rounded-xl text-balance text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#a3f0d6]"
      href={href}
    >
      {children}
    </a>
  );
}

function PassOfferAction({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center gap-2 text-[.82rem] leading-[1.25] font-[740] text-balance underline-offset-[.18em] group-hover:underline">
      {children}
      <span
        aria-hidden="true"
        className="size-1.5 flex-none rotate-45 border-t-[1.5px] border-e-[1.5px]"
      />
    </span>
  );
}

// The global h3 rule sets the subheading font outside any layer, so the
// title's font needs to outrank it.
const offerTitleClassName =
  "[font-family:var(--font-heading)]! text-[1.84rem] leading-[1.05] font-[690]! tracking-[-0.05em] text-balance wrap-break-word";
const offerDetailClassName =
  "mt-[7px] text-[.92rem] leading-[1.36] text-balance";

/**
 * An Entry pack as a perforated admission ticket whose outline follows both
 * notches of its tear-off stub.
 */
export function EntryPackOfferCard({ href, locale, tier }: PassOfferCardProps) {
  return (
    <PassOfferLink
      href={href}
      label={m.entryPackOfferLabel(
        { tier: getPassTierName(tier, locale) },
        { locale }
      )}
    >
      <article
        className="@container relative isolate grid min-h-41 grid-cols-[minmax(0,1fr)_minmax(82px,27%)] border border-transparent text-[#6a270e]"
        data-pass-offer="entry-pack"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px -z-10 drop-shadow-[0_3px_3px_#65371b10]"
        >
          <span
            className="absolute inset-0 rounded-[11px] bg-[#d4a17d]"
            style={notchMask({
              fold: "calc(100% - max(82px, calc(27% - .54px)))",
              top: "0px",
              bottom: "100%",
              radius: "9px",
            })}
          />
          <span
            className="absolute inset-px isolate overflow-clip rounded-[10px]"
            style={entryPackTicketFace}
          >
            <span
              data-watermark="body"
              style={{
                ...watermarkHalf,
                clipPath:
                  "inset(0 calc(100% - var(--seam-from-mark-start)) 0 0)",
                background: "#ead8c6",
                mixBlendMode: "darken",
                opacity: 0.78,
              }}
            />
            <span
              data-watermark="stub"
              style={{
                ...watermarkHalf,
                clipPath: "inset(0 0 0 var(--seam-from-mark-start))",
                background: "#1b100a",
                mixBlendMode: "soft-light",
                opacity: 0.72,
              }}
            />
          </span>
        </span>
        <div className="grid content-between gap-3.5 px-4 py-3.5 @max-[320px]:ps-[15px] @max-[320px]:pe-2.5">
          <header>
            <h3
              className={cn(offerTitleClassName, "@max-[320px]:text-[1.62rem]")}
            >
              {m.passEntryPack({}, { locale })}
            </h3>
            <p className={cn(offerDetailClassName, "text-[#793f25]")}>
              {m.entryPackOfferTagline({}, { locale })}
            </p>
          </header>
          <PassOfferAction>
            {m.entryPackOfferAction({}, { locale })}
          </PassOfferAction>
        </div>
        <div className="relative grid min-w-0 content-center border-s-2 border-transparent px-2 py-4 text-center before:absolute before:inset-y-[11px] before:-start-0.5 before:border-s-2 before:border-dashed before:border-[#ae6e4c] before:content-['']">
          <span className="text-[1.28rem] leading-none font-[740] tracking-[-0.04em] text-balance @max-[255px]:text-[1.11rem]">
            {m.entryPackOfferSizes(
              { smaller: smallerEntryPack, larger: largerEntryPack },
              { locale }
            )}
          </span>
          <span className="mt-1 text-[.73rem] font-[690] tracking-[.08em] uppercase">
            {m.entryPackOfferVisits({}, { locale })}
          </span>
        </div>
      </article>
    </PassOfferLink>
  );
}

const unlimitedPassColours: VariableStyle<
  "pass-base" | "pass-top" | "pass-glow" | "pass-line"
> = {
  "--pass-base": "#761730",
  "--pass-top": "#83223a",
  "--pass-glow": "#942941",
  "--pass-line": "#f5c0d050",
  background:
    "radial-gradient(ellipse at 100% 0%, var(--pass-glow) 0%, transparent 58%), linear-gradient(158deg, var(--pass-top) 5%, var(--pass-base) 84%)",
};

/**
 * An Unlimited pass as a Workspace membership credential: issuer line with a
 * foil stripe, the Workspace mark in the photo area, and the expiry a pass
 * bought for this draft would have.
 */
export function UnlimitedPassOfferCard({
  expiresOn,
  href,
  locale,
  tier,
  expiryId,
}: PassOfferCardProps & {
  readonly expiresOn: Temporal.PlainDate;
  /** Lets the link describe itself with the expiry. */
  readonly expiryId: string;
}) {
  return (
    <PassOfferLink
      aria-describedby={expiryId}
      href={href}
      label={m.unlimitedPassOfferLabel(
        { tier: getPassTierName(tier, locale) },
        { locale }
      )}
    >
      <article
        className="@container grid min-h-41 rounded-2xl border border-[#b06c7d] text-[#fff6f8] shadow-[0_3px_8px_#060a3a22]"
        data-pass-offer="unlimited"
        style={unlimitedPassColours}
      >
        <div className="relative grid grid-cols-[clamp(48px,20cqw,66px)_minmax(0,1fr)] content-between items-center gap-x-3 gap-y-2 px-3.5 py-3 @max-[380px]:grid-cols-[clamp(48px,20cqi,66px)_minmax(0,1fr)] @max-[380px]:gap-x-[9px] @max-[380px]:gap-y-[7px] @max-[380px]:px-3 @max-[380px]:py-2.5 @max-[255px]:grid-cols-[54px_minmax(0,1fr)]">
          <div className="col-span-full flex items-center gap-2 text-[.74rem] leading-[1.2] font-semibold text-[#fae8ee] @max-[320px]:text-[.67rem]">
            <span>{m.workspaceTitle({}, { locale })}</span>
            <span
              aria-hidden="true"
              className="h-px flex-1 bg-linear-to-r from-[#f5c0d050] to-transparent"
            />
            <span
              aria-hidden="true"
              className="h-1 w-[35px] flex-none rounded-[2px] bg-[linear-gradient(105deg,#ffc2cc_0%,#d999bf_55%,#f3d9c6_100%)]"
              data-foil-stripe=""
            />
          </div>
          <div
            aria-hidden="true"
            className="grid aspect-[1/1.02] place-items-center rounded-lg border border-[#efb5cb73] p-[11px] @max-[380px]:p-[7px] [background:repeating-linear-gradient(138deg,#ffccdc20_0_1px,transparent_1px_6px),linear-gradient(132deg,#f3b8c848,#e5a2c024_77%)]"
          >
            <span
              className="aspect-[289/327] w-[min(100%,48px)] bg-[#fff2f5]"
              data-workspace-mark=""
              style={{ mask: markMask, WebkitMask: markMask }}
            />
          </div>
          <header>
            <h3
              className={cn(
                offerTitleClassName,
                "@max-[380px]:text-[1.65rem] @max-[320px]:text-[1.4rem]"
              )}
            >
              {m.passMembership({}, { locale })}
            </h3>
            <p
              className={cn(
                offerDetailClassName,
                "text-[#fae8ee] @max-[380px]:mt-1 @max-[380px]:leading-[1.24] @max-[320px]:text-[.82rem]"
              )}
            >
              {
                {
                  "open-space": m.unlimitedPassOfferTaglineOpenSpace(
                    {},
                    { locale }
                  ),
                  "reserved-desk": m.unlimitedPassOfferTaglineReservedDesk(
                    {},
                    { locale }
                  ),
                  "reserved-desk-workstation":
                    m.unlimitedPassOfferTaglineReservedDesk({}, { locale }),
                }[tier]
              }
            </p>
          </header>
          <footer className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[#f5c0d050] pt-2 text-[#ffdae6] @max-[380px]:pt-[7px]">
            <span
              className="flex-[1_1_0] text-[.74rem] leading-[1.2] font-normal text-[#eadce0] @max-[320px]:text-[.67rem] text-balance"
              id={expiryId}
            >
              <Interpolate
                string={m.unlimitedPassOfferExpiry(
                  { date: formatPassDate(expiresOn.toString(), locale) },
                  { locale }
                )}
                mapping={{
                  date: (label) => (
                    <time
                      className="whitespace-nowrap"
                      dateTime={expiresOn.toString()}
                    >
                      {label}
                    </time>
                  ),
                }}
              />
            </span>
            <span className="ms-auto @max-[320px]:[&>span]:text-[.73rem]">
              <PassOfferAction>
                {m.unlimitedPassOfferAction({}, { locale })}
              </PassOfferAction>
            </span>
          </footer>
        </div>
      </article>
    </PassOfferLink>
  );
}
