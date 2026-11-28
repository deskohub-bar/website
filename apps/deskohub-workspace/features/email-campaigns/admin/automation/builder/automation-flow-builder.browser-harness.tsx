import {
  AdministrationCampaignDelivery,
  AdministrationCampaignDetail,
  AdministrationCampaignLocale,
  AdministrationCampaignStatus,
  AutomationDetail,
  AutomationFrequency,
} from "@deskohub/workspace-admin-api";
import { Effect, Schema } from "effect";
import { createRoot } from "react-dom/client";
import type { Locale } from "@/features/i18n";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { AutomationFlowBuilder } from "./automation-flow-builder";
import type { AutomationFlowBuilderData } from "./automation-flow-page-data.server";

const mountPoint = document.getElementById("automation-flow-builder-root");
const fixture = document.getElementById("automation-flow-builder-fixture");

if (!mountPoint || !fixture?.textContent) {
  throw new Error("The AutomationFlowBuilder browser harness root is missing.");
}

const ValueOption = Schema.Struct({ id: Schema.String, name: Schema.String });
const CampaignOption = Schema.Struct({
  ...ValueOption.fields,
  delivery: AdministrationCampaignDelivery,
  status: AdministrationCampaignStatus,
});
const CalendarPreview = Schema.Union([
  Schema.TaggedStruct("Ready", {
    description: Schema.String,
    nextStarts: Schema.Array(Schema.String),
    frequency: AutomationFrequency,
  }),
  Schema.TaggedStruct("Failed", {
    message: Schema.String,
    code: Schema.UndefinedOr(Schema.String).pipe(
      Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined))
    ),
  }),
]);
const BuilderData = Schema.Struct({
  lookups: Schema.Struct({
    discountGroups: Schema.optionalKey(Schema.Array(ValueOption)),
    campaigns: Schema.optionalKey(Schema.Array(CampaignOption)),
  }),
  savedAudiences: Schema.Array(ValueOption),
  calendarPreviews: Schema.Record(Schema.String, CalendarPreview),
}) satisfies Schema.Decoder<AutomationFlowBuilderData>;

const BuilderFixture = Schema.fromJsonString(
  Schema.Struct({
    campaign: AdministrationCampaignDetail,
    automation: AutomationDetail,
    data: BuilderData,
  })
);
const props = Schema.decodeUnknownSync(BuilderFixture)(fixture.textContent);
const locale: Locale = Schema.decodeUnknownSync(AdministrationCampaignLocale)(
  mountPoint.dataset.locale
);

createRoot(mountPoint).render(
  <RouteLocaleProvider locale={locale}>
    <AutomationFlowBuilder {...props} />
  </RouteLocaleProvider>
);
