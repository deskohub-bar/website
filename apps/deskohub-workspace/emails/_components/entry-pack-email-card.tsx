import { Link, Section, Text } from "react-email";
import { type Locale, m } from "@/features/i18n";
import type { EntryPackSize, PassTier } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { WorkspaceEmailLabel } from "./workspace-email-content";

export function EntryPackEmailCard({
  action,
  dates,
  entryCount,
  locale,
  tier,
}: {
  readonly action: { readonly label: string; readonly url: string };
  readonly dates: string;
  readonly entryCount: EntryPackSize | null;
  readonly locale: Locale;
  readonly tier: PassTier;
}) {
  return (
    <Section className="mt-6 overflow-hidden rounded-[22px] border border-[#d8d9e4]">
      <Section className="bg-[#e9fff6] px-5 py-5 text-center">
        <WorkspaceEmailLabel>
          {m.passEntryPack({}, { locale })} · {getPassTierName(tier, locale)}
        </WorkspaceEmailLabel>
        <Text className="m-0 mt-1 text-[38px] font-bold leading-[46px] text-navy">
          {entryCount === null
            ? m.passUnlimited({}, { locale })
            : m.passEntryCount({ count: entryCount }, { locale })}
        </Text>
        <Text className="m-0 mt-1 text-[14px] text-navy">{dates}</Text>
      </Section>
      <Section
        bgcolor="#00024f"
        className="border-t-4 border-aquamarine bg-navy px-4 py-6 text-center"
      >
        <Link
          className="inline-block rounded-full px-7 py-3 text-[14px] font-bold text-navy no-underline"
          href={action.url}
          style={{ backgroundColor: "#00df99", color: "#00024f" }}
        >
          {action.label}
        </Link>
      </Section>
    </Section>
  );
}
