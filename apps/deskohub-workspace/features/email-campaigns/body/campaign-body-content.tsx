import { renderEmailRichText } from "@/features/emails/body/email-rich-text";
import type { Locale } from "@/features/i18n";
import type { CampaignBodyDocument } from "./campaign-body-document";

/** Renders a campaign body as React Email components in its `locale`. */
export function CampaignBodyContent({
  body,
  locale,
}: {
  readonly body: CampaignBodyDocument;
  readonly locale: Locale;
}) {
  return renderEmailRichText(body.doc, { locale });
}
