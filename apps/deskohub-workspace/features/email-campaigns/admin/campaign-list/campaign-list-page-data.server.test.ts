import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, test } from "bun:test";
import type { AdministrationCampaignSummaryType } from "@deskohub/workspace-admin-api";
import { Effect } from "effect";
import {
  campaignAudienceIdSchema,
  campaignIdSchema,
} from "../../campaign-identifiers";
import {
  campaignAudienceFixture,
  stubCampaignPageQueries,
} from "../campaign-operation-query.test-utils";

const port = stubCampaignPageQueries();

const { loadCampaignList, loadCampaignListDelivery } = await import(
  "./campaign-list-page-data.server"
);

const summary = (
  id: string,
  fields: Pick<AdministrationCampaignSummaryType, "delivery" | "status"> &
    Partial<Pick<AdministrationCampaignSummaryType, "audienceId">>
): AdministrationCampaignSummaryType => ({
  id: campaignIdSchema.make(id),
  title: `Campaign ${id}`,
  purpose: "marketing",
  templateKey: "workspace",
  audienceId: null,
  locales: [],
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-05T08:00:00.000Z",
  ...fields,
});

const regulars = campaignAudienceIdSchema.make("regulars");
const onceDraft = summary("once-draft", {
  delivery: "once",
  status: "draft",
  audienceId: regulars,
});
const automatedActive = summary("automated-active", {
  delivery: "automated",
  status: "active",
  audienceId: campaignAudienceIdSchema.make("deleted-audience"),
});

beforeEach(() => {
  port.access.set("administrator");
  port.invoked.length = 0;
  port.responses = {
    listCampaigns: Effect.succeed([onceDraft, automatedActive]),
    listCampaignAudiences: Effect.succeed([
      campaignAudienceFixture(regulars, "Regulars"),
    ]),
  };
});

describe("loadCampaignListDelivery", () => {
  test("reads a known delivery from the URL and ignores anything else", async () => {
    const deliveryOf = (delivery: string | string[] | undefined) =>
      loadCampaignListDelivery(Promise.resolve({ delivery }));

    expect(await deliveryOf("once")).toBe("once");
    expect(await deliveryOf("automated")).toBe("automated");
    expect(await deliveryOf("weekly")).toBeUndefined();
    expect(await deliveryOf(["once"])).toBeUndefined();
    expect(await deliveryOf(undefined)).toBeUndefined();
  });
});

describe("loadCampaignList", () => {
  test("lists every campaign with its delivery, status, and audience title", async () => {
    expect(await loadCampaignList(Promise.resolve(undefined))).toEqual([
      {
        id: onceDraft.id,
        title: "Campaign once-draft",
        purpose: "marketing",
        audienceTitle: "Regulars",
        updatedAt: "2026-10-05T08:00:00.000Z",
        delivery: "once",
        status: "draft",
      },
      {
        id: automatedActive.id,
        title: "Campaign automated-active",
        purpose: "marketing",
        audienceTitle: null,
        updatedAt: "2026-10-05T08:00:00.000Z",
        delivery: "automated",
        status: "active",
      },
    ]);
  });

  test("keeps only the campaigns of the shown delivery", async () => {
    const idsOf = async (delivery: "once" | "automated") =>
      (await loadCampaignList(Promise.resolve(delivery))).map(({ id }) => id);

    expect(await idsOf("once")).toEqual([onceDraft.id]);
    expect(await idsOf("automated")).toEqual([automatedActive.id]);
  });

  test("a campaign without an audience lists with no audience title", async () => {
    port.responses.listCampaigns = Effect.succeed([
      summary("no-audience", { delivery: "once", status: "sent" }),
    ]);

    expect(await loadCampaignList(Promise.resolve(undefined))).toMatchObject([
      { id: "no-audience", audienceTitle: null, status: "sent" },
    ]);
  });

  test("drops a campaign whose status doesn't belong to its delivery", async () => {
    port.responses.listCampaigns = Effect.succeed([
      summary("once-active", { delivery: "once", status: "active" }),
      summary("automated-sent", { delivery: "automated", status: "sent" }),
      onceDraft,
    ]);

    expect(
      (await loadCampaignList(Promise.resolve(undefined))).map(({ id }) => id)
    ).toEqual([onceDraft.id]);
  });

  test("reads the campaigns and audiences from the campaign port", async () => {
    await loadCampaignList(Promise.resolve(undefined));

    expect(port.invoked.map(({ name }) => name).sort()).toEqual([
      "listCampaignAudiences",
      "listCampaigns",
    ]);
  });
});
