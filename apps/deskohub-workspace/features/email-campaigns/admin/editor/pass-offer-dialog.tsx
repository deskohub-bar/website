"use client";

import { effectSchemaResolver } from "@deskohub/effect-schema-resolver";
import { Predicate, Schema } from "effect";
import { useId } from "react";
import { useForm } from "react-hook-form";
import { m } from "@/features/administration/i18n";
import { m as customerMessages, type Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import type { EntryPackSize } from "@/features/passes/pass-offer";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/shared/components/ui/form";
import { Input } from "@/shared/components/ui/input";
import { SegmentedControl } from "@/shared/components/ui/segmented-control";
import type { CampaignBodyAttributeValue } from "../../body/campaign-body-document";
import { campaignPassOfferIssues } from "../../body/campaign-body-rules";
import {
  type CampaignPassOfferProduct,
  campaignPassOfferProducts,
  campaignPassOfferSizes,
  campaignPassOfferText,
  isCampaignPassOfferProduct,
  isCampaignPassOfferSize,
} from "../../body/campaign-pass-offer";
import { localeContentIssueMessage } from "../composer/campaign-composer-fields";

/** A pass offer node's attributes, as the editor stores them. */
export type PassOfferValues = {
  readonly product: CampaignPassOfferProduct;
  /** An Entry pack size the purchase page opens on; null for the default. */
  readonly size: EntryPackSize | null;
  readonly headline: string | null;
  readonly detail: string | null;
};

/** A node's attributes as found, which a Markdown body may have left invalid. */
export type PassOfferAttributes = Readonly<
  Record<string, CampaignBodyAttributeValue>
>;

const defaultSize = "default";
/** A size the body rules refuse, as found; no choice matches it. */
const invalidSize = "invalid";

type PassOfferForm = {
  readonly product: string;
  /** `default`, a size's digits, or `invalid` for a size the rules refuse. */
  readonly size: string;
  readonly headline: string;
  readonly detail: string;
};

/** The node's attributes for the form: empty texts are null, and only an Entry pack has a size. */
const toPassOfferAttributes = ({
  product,
  size,
  headline,
  detail,
}: PassOfferForm) => ({
  product,
  size: product === "entry-pack" && size !== defaultSize ? Number(size) : null,
  headline: headline.trim() || null,
  detail: detail.trim() || null,
});

// An invalid size stays, so validation names it until a size is chosen.
const toPassOfferFormSize = (size: PassOfferAttributes["size"] | undefined) => {
  if (size === undefined || size === null) {
    return defaultSize;
  }
  return isCampaignPassOfferSize(size) ? `${size}` : invalidSize;
};

const toPassOfferForm = (
  attributes: PassOfferAttributes | undefined
): PassOfferForm => ({
  product: Predicate.isString(attributes?.product)
    ? attributes.product
    : "entry-pack",
  size: toPassOfferFormSize(attributes?.size),
  headline: campaignPassOfferText(attributes?.headline) ?? "",
  detail: campaignPassOfferText(attributes?.detail) ?? "",
});

/** The body rule issue on `field`, if any, in the admin's `locale`. */
const passOfferFieldCheck = (field: keyof PassOfferForm, locale: Locale) =>
  Schema.makeFilter((form: PassOfferForm) => {
    const issue = campaignPassOfferIssues(toPassOfferAttributes(form), []).find(
      (candidate) => candidate.path.at(-1) === field
    );
    return (
      issue === undefined || {
        path: [field],
        issue: localeContentIssueMessage(issue, locale),
      }
    );
  });

/**
 * The card form; `locale` is the admin's language for its messages. Each
 * body rule issue shows on the field it names.
 */
const createPassOfferFields = (locale: Locale) =>
  Schema.Struct({
    product: Schema.String,
    size: Schema.String,
    headline: Schema.String,
    detail: Schema.String,
  }).check(
    passOfferFieldCheck("product", locale),
    passOfferFieldCheck("size", locale),
    passOfferFieldCheck("headline", locale),
    passOfferFieldCheck("detail", locale)
  );

type PassOfferSchema = ReturnType<typeof createPassOfferFields>;

/** Inserts or edits a pass offer card: its product, size, and texts. */
export function PassOfferDialog({
  initialAttributes,
  onOpenChange,
  onRemove,
  onSubmit,
  open,
}: {
  /** Set when editing an existing card. */
  readonly initialAttributes?: PassOfferAttributes;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemove?: () => void;
  readonly onSubmit: (values: PassOfferValues) => void;
  readonly open: boolean;
}) {
  const locale = useRouteLocale();
  const editing = initialAttributes !== undefined;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/* The form is taller than a phone held sideways: scroll, so its actions stay reachable. */}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        locale={locale}
      >
        <DialogHeader>
          <DialogTitle>
            {editing
              ? m.emailCampaignsPassOfferEdit({}, { locale })
              : m.emailCampaignsPassOfferInsert({}, { locale })}
          </DialogTitle>
          <DialogDescription>
            {m.emailCampaignsPassOfferDescription({}, { locale })}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <PassOfferForm
            editing={editing}
            initialAttributes={initialAttributes}
            locale={locale}
            onCancel={() => onOpenChange(false)}
            onRemove={onRemove}
            onSubmit={(values) => {
              onSubmit(values);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PassOfferForm({
  editing,
  initialAttributes,
  locale,
  onCancel,
  onRemove,
  onSubmit,
}: {
  readonly editing: boolean;
  readonly initialAttributes: PassOfferAttributes | undefined;
  readonly locale: Locale;
  readonly onCancel: () => void;
  readonly onRemove: (() => void) | undefined;
  readonly onSubmit: (values: PassOfferValues) => void;
}) {
  const form = useForm<
    PassOfferSchema["Encoded"],
    unknown,
    PassOfferSchema["Type"]
  >({
    resolver: effectSchemaResolver(createPassOfferFields(locale)),
    defaultValues: toPassOfferForm(initialAttributes),
  });
  const product = form.watch("product");
  const headlineHintId = useId();
  const detailHintId = useId();
  const sizeHintId = useId();

  return (
    <Form {...form}>
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          // The dialog portals out of the composer form, but React still
          // bubbles submit events through the component tree.
          event.stopPropagation();
          return form.handleSubmit((values) => {
            const attributes = toPassOfferAttributes(values);
            // Validation has already accepted the product.
            if (!isCampaignPassOfferProduct(attributes.product)) return;
            onSubmit({
              ...attributes,
              product: attributes.product,
              size: isCampaignPassOfferSize(attributes.size)
                ? attributes.size
                : null,
            });
          })(event);
        }}
      >
        <FormField
          control={form.control}
          name="product"
          render={({ field }) => (
            <FormItem>
              {/* The group's legend names it for assistive technology. */}
              <p aria-hidden="true" className="font-medium text-sm">
                {m.emailCampaignsPassOfferProductLabel({}, { locale })}
              </p>
              <SegmentedControl
                label={m.emailCampaignsPassOfferProductLabel({}, { locale })}
                name={field.name}
                onValueChange={(value) => {
                  field.onChange(value);
                  // Only an Entry pack has a size.
                  if (value !== "entry-pack") {
                    form.setValue("size", defaultSize);
                    form.clearErrors("size");
                  }
                }}
                options={campaignPassOfferProducts.map((value) => ({
                  value,
                  label: passOfferProductName(value, locale),
                }))}
                value={field.value}
              />
              <FormMessage />
            </FormItem>
          )}
        />
        {product === "entry-pack" && (
          <FormField
            control={form.control}
            name="size"
            render={({ field }) => (
              <FormItem>
                <p aria-hidden="true" className="font-medium text-sm">
                  {m.emailCampaignsPassOfferSizeLabel({}, { locale })}
                </p>
                <SegmentedControl
                  label={m.emailCampaignsPassOfferSizeLabel({}, { locale })}
                  name={field.name}
                  onValueChange={field.onChange}
                  options={[
                    {
                      value: defaultSize,
                      label: m.emailCampaignsPassOfferSizeDefault(
                        {},
                        { locale }
                      ),
                    },
                    ...campaignPassOfferSizes.map((size) => ({
                      value: `${size}` as const,
                      label: size,
                    })),
                  ]}
                  value={field.value}
                />
                <p className="text-navy-blue/60 text-xs" id={sizeHintId}>
                  {m.emailCampaignsPassOfferSizeHint({}, { locale })}
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={form.control}
          name="headline"
          // A headline settles a detail's missing-headline issue.
          rules={{ deps: "detail" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {m.emailCampaignsPassOfferHeadlineLabel({}, { locale })}
              </FormLabel>
              <FormControl aria-describedby={headlineHintId}>
                <Input
                  placeholder={m.emailCampaignsPassOfferHeadlinePlaceholder(
                    {},
                    { locale }
                  )}
                  {...field}
                />
              </FormControl>
              <p className="text-navy-blue/60 text-xs" id={headlineHintId}>
                {m.emailCampaignsPassOfferHeadlineHint({}, { locale })}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="detail"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {m.emailCampaignsPassOfferDetailLabel({}, { locale })}
              </FormLabel>
              <FormControl aria-describedby={detailHintId}>
                <Input
                  placeholder={m.emailCampaignsPassOfferDetailPlaceholder(
                    {},
                    { locale }
                  )}
                  {...field}
                />
              </FormControl>
              <p className="text-navy-blue/60 text-xs" id={detailHintId}>
                {m.emailCampaignsPassOfferDetailHint({}, { locale })}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          {onRemove && (
            <Button
              className="sm:mr-auto"
              onClick={onRemove}
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.emailCampaignsPassOfferRemove({}, { locale })}
            </Button>
          )}
          <Button
            onClick={onCancel}
            size="sm"
            type="button"
            variant="secondary"
          >
            {m.emailCampaignsPassOfferCancel({}, { locale })}
          </Button>
          <Button size="sm" type="submit">
            {editing
              ? m.emailCampaignsPassOfferUpdate({}, { locale })
              : m.emailCampaignsPassOfferInsert({}, { locale })}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

/** The product's customer-facing name, in `locale`. */
export const passOfferProductName = (
  product: CampaignPassOfferProduct,
  locale: Locale
) =>
  product === "entry-pack"
    ? customerMessages.passEntryPack({}, { locale })
    : customerMessages.passUnlimited({}, { locale });
