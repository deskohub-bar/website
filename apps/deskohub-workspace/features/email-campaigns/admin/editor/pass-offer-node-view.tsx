"use client";

import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ArrowRight, Pencil } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { m } from "@/features/administration/i18n";
import { m as customerMessages, type Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { unlimitedPassDays } from "@/features/passes/pass-offer";
import {
  entryPackCheckoutPath,
  unlimitedPassCheckoutPath,
} from "@/features/passes/routes";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils";
import {
  type CampaignPassOfferProduct,
  campaignPassOfferText,
  isCampaignPassOfferProduct,
  isCampaignPassOfferSize,
} from "../../body/campaign-pass-offer";
import { PassOfferDialog, passOfferProductName } from "./pass-offer-dialog";

/**
 * The editor's rendering of a pass offer card, in the body's language
 * `contentLocale`; Edit on the selected card opens it.
 */
export function PassOfferNodeView({
  contentLocale,
  deleteNode,
  editor,
  node,
  selected,
  updateAttributes,
}: ReactNodeViewProps & { readonly contentLocale: Locale }) {
  const locale = useRouteLocale();
  const [editing, setEditing] = useState(false);
  const { product, size } = node.attrs;

  return (
    <NodeViewWrapper className="my-4 flex flex-col gap-1.5" data-pass-offer="">
      <div className="relative w-full max-w-md self-center">
        {isCampaignPassOfferProduct(product) ? (
          <PassOfferCardFace
            detail={campaignPassOfferText(node.attrs.detail)}
            headline={campaignPassOfferText(node.attrs.headline)}
            locale={contentLocale}
            product={product}
            selected={selected}
          />
        ) : (
          <span
            className={cn(
              "flex min-h-20 cursor-pointer select-none items-center justify-center rounded-md border border-burned-orange border-dashed px-4 text-center text-burned-orange-ink text-sm italic",
              selected && "ring-2 ring-navy-blue ring-offset-2"
            )}
            data-drag-handle=""
          >
            {m.emailCampaignsBodyPassOfferProductInvalid({}, { locale })}
          </span>
        )}
        {selected && editor.isEditable && (
          <Button
            className="absolute -right-3 -top-3"
            contentEditable={false}
            onClick={() => setEditing(true)}
            size="icon-sm"
            type="button"
            variant="secondary"
          >
            <Pencil aria-hidden className="size-3.5" />
            <span className="sr-only">
              {m.emailCampaignsPassOfferEdit({}, { locale })}
            </span>
          </Button>
        )}
      </div>
      {isCampaignPassOfferProduct(product) && (
        <span
          className="max-w-full self-center truncate text-navy-blue/55 text-xs"
          contentEditable={false}
        >
          {product === "entry-pack"
            ? `${entryPackCheckoutPath}${isCampaignPassOfferSize(size) ? `?size=${size}` : ""}`
            : unlimitedPassCheckoutPath}
        </span>
      )}
      <PassOfferDialog
        initialAttributes={node.attrs}
        onOpenChange={setEditing}
        onRemove={() => {
          setEditing(false);
          deleteNode();
        }}
        onSubmit={(values) => updateAttributes(values)}
        open={editing}
      />
    </NodeViewWrapper>
  );
}

/** Each product's card colours, as the email card paints them. */
const passOfferCardStyles = {
  "entry-pack": {
    card: {
      backgroundColor: "#f9cb70",
      backgroundImage:
        "linear-gradient(105deg, #ffe2a4 5%, #f9cb70 71%, #ebb25a)",
      borderLeft: "4px solid #a43810",
      color: "#5b2407",
    },
    detail: { color: "#6b3410" },
    stub: { borderLeft: "1.5px dashed #9a4a1c" },
    badge: { backgroundColor: "#652607", color: "#fff2d4" },
  },
  unlimited: {
    card: {
      backgroundColor: "#761730",
      backgroundImage:
        "radial-gradient(ellipse at 100% 0%, #942941 0%, transparent 58%), linear-gradient(158deg, #83223a 5%, #761730 85%)",
      border: "1px solid #b06c7d",
      color: "#fff6f8",
    },
    detail: { color: "#f6dce4" },
    stub: {},
    badge: { backgroundColor: "#ffdae6", color: "#761730" },
  },
} satisfies Record<
  CampaignPassOfferProduct,
  Record<"card" | "detail" | "stub" | "badge", CSSProperties>
>;

/**
 * The card as the email shows it: the product name, the headline or else the
 * product's benefit line, and the detail.
 */
function PassOfferCardFace({
  detail,
  headline,
  locale,
  product,
  selected,
}: {
  readonly detail: string | undefined;
  readonly headline: string | undefined;
  readonly locale: Locale;
  readonly product: CampaignPassOfferProduct;
  readonly selected: boolean;
}) {
  const styles = passOfferCardStyles[product];
  return (
    <span
      className={cn(
        "flex cursor-pointer select-none items-stretch overflow-hidden rounded-md",
        selected && "ring-2 ring-navy-blue ring-offset-2"
      )}
      data-drag-handle=""
      lang={locale}
      style={styles.card}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3">
        <span className="font-semibold text-xs uppercase tracking-wide opacity-80">
          {passOfferProductName(product, locale)}
        </span>
        <span className="font-semibold text-lg leading-snug">
          {headline ??
            (product === "entry-pack"
              ? customerMessages.emailPassOfferEntryPackBenefit({}, { locale })
              : customerMessages.emailPassOfferUnlimitedBenefit(
                  { count: unlimitedPassDays },
                  { locale }
                ))}
        </span>
        {detail !== undefined && (
          <span className="text-sm leading-snug" style={styles.detail}>
            {detail}
          </span>
        )}
      </span>
      <span
        className="flex w-16 shrink-0 items-center justify-center"
        style={styles.stub}
      >
        <span
          className="flex size-8 items-center justify-center rounded-full"
          style={styles.badge}
        >
          <ArrowRight aria-hidden className="size-4" />
        </span>
      </span>
    </span>
  );
}
