import { afterAll, afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { m } from "@/features/administration/i18n";
import { m as customerMessages } from "@/features/i18n";
import { unlimitedPassDays } from "@/features/passes/pass-offer";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import type { CampaignBodyNode } from "../../body/campaign-body-document";
import { campaignPassOfferTextMaxLength } from "../../body/campaign-body-rules";
import {
  campaignBodyOf,
  loadCampaignBodyEditorHarness,
} from "./campaign-body-editor.test-utils";

registerWorkspaceComponentTestEnv();
const { act, cleanup, fireEvent, renderEditor, screen, waitFor, within } =
  await loadCampaignBodyEditorHarness();

/** The admin's language; the harness writes the body in Czech. */
const locale = "en-US";
const contentLocale = "cs-CZ";
/** The card's position: after the 8-position paragraph "Podzim". */
const cardPosition = 8;

const bodyWithCard = (attrs: CampaignBodyNode["attrs"]) =>
  campaignBodyOf("Podzim", { type: "passOffer", attrs });

const entryPackCard = {
  product: "entry-pack",
  size: 5,
  headline: "Ušetřete 460 Kč",
  detail: "na 5 návštěv",
};

type Rendered = Awaited<ReturnType<typeof renderEditor>>;
type Scope = ReturnType<typeof within>;

const cardView = ({ view }: Rendered) => {
  const element =
    view.container.querySelector<HTMLElement>("[data-pass-offer]");
  if (!element) throw new Error("The card isn't shown");
  return within(element);
};

const editButton = (rendered: Rendered) =>
  cardView(rendered).queryByRole("button", {
    name: m.emailCampaignsPassOfferEdit({}, { locale }),
  });

const selectCard = async (rendered: Rendered) => {
  act(() => {
    rendered.editor.commands.setNodeSelection(cardPosition);
  });
  return waitFor(() => {
    const button = editButton(rendered);
    assert(
      button,
      "Expected the pass offer edit button after selecting the node."
    );
    return button;
  });
};

const openEditing = async (rendered: Rendered) => {
  const button = await selectCard(rendered);
  await act(async () => {
    fireEvent.click(button);
  });
  return within(screen.getByRole("dialog"));
};

const textField = (dialog: Scope, name: string) =>
  dialog.getByLabelText<HTMLInputElement>(name);
const headlineField = (dialog: Scope) =>
  textField(dialog, m.emailCampaignsPassOfferHeadlineLabel({}, { locale }));
const detailField = (dialog: Scope) =>
  textField(dialog, m.emailCampaignsPassOfferDetailLabel({}, { locale }));
const choice = (dialog: Scope, name: string) =>
  dialog.queryByRole<HTMLInputElement>("radio", { name });

const clickChoice = async (dialog: Scope, name: string) => {
  await act(async () => {
    fireEvent.click(dialog.getByRole("radio", { name }));
  });
};

const clickIn = async (dialog: Scope, name: string) => {
  await act(async () => {
    fireEvent.click(dialog.getByRole("button", { name }));
  });
};

const cardsOf = (body: CampaignBodyNode | undefined) =>
  (body?.content ?? []).filter(({ type }) => type === "passOffer");

// Waits compare with null: printing a happy-dom element for a failed check
// takes seconds, and polling waits often fail their first check.
describe("PassOfferNodeView", () => {
  afterEach(() => cleanup());
  afterAll(() => unregisterWorkspaceComponentTestEnv());

  test("previews the card in the body's language, with Edit only while it's selected", async () => {
    const rendered = await renderEditor(bodyWithCard(entryPackCard));

    expect(
      cardView(rendered).getByText(
        customerMessages.passEntryPack({}, { locale: contentLocale })
      )
    ).toBeTruthy();
    expect(cardView(rendered).getByText(entryPackCard.headline)).toBeTruthy();
    expect(cardView(rendered).getByText(entryPackCard.detail)).toBeTruthy();
    expect(
      cardView(rendered).getByText("/passes/entry-pack?size=5")
    ).toBeTruthy();
    expect(editButton(rendered)).toBeNull();

    await selectCard(rendered);
    act(() => {
      rendered.editor.commands.setTextSelection(2);
    });

    await waitFor(() => expect(editButton(rendered) === null).toBe(true));
  });

  test("shows the product's benefit line where the card has no headline", async () => {
    const rendered = await renderEditor(
      bodyWithCard({ product: "unlimited", size: null })
    );

    expect(
      cardView(rendered).getByText(
        customerMessages.passUnlimited({}, { locale: contentLocale })
      )
    ).toBeTruthy();
    expect(
      cardView(rendered).getByText(
        customerMessages.emailPassOfferUnlimitedBenefit(
          { count: unlimitedPassDays },
          { locale: contentLocale }
        )
      )
    ).toBeTruthy();
    expect(cardView(rendered).getByText("/passes/unlimited")).toBeTruthy();
  });

  test("switching to the Unlimited pass drops the size and empty texts are stored as none", async () => {
    const rendered = await renderEditor(bodyWithCard(entryPackCard));
    const dialog = await openEditing(rendered);

    expect(choice(dialog, "5")?.checked).toBe(true);
    expect(headlineField(dialog).value).toBe(entryPackCard.headline);
    await clickChoice(dialog, customerMessages.passUnlimited({}, { locale }));
    expect(choice(dialog, "5")).toBeNull();
    fireEvent.input(headlineField(dialog), {
      target: { value: "  Ušetřete 2 210 Kč  " },
    });
    fireEvent.input(detailField(dialog), { target: { value: "  " } });
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true)
    );
    expect(cardsOf(rendered.changes.at(-1))).toEqual([
      {
        type: "passOffer",
        attrs: {
          product: "unlimited",
          size: null,
          headline: "Ušetřete 2 210 Kč",
          detail: null,
        },
      },
    ]);
  });

  test("switching away from the Entry pack and back forgets its size", async () => {
    const rendered = await renderEditor(bodyWithCard(entryPackCard));
    const dialog = await openEditing(rendered);

    for (const product of [
      customerMessages.passUnlimited({}, { locale }),
      customerMessages.passEntryPack({}, { locale }),
    ]) {
      await clickChoice(dialog, product);
    }
    expect(
      choice(dialog, m.emailCampaignsPassOfferSizeDefault({}, { locale }))
        ?.checked
    ).toBe(true);
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true)
    );
    expect(cardsOf(rendered.changes.at(-1))).toEqual([
      {
        type: "passOffer",
        attrs: { ...entryPackCard, size: null },
      },
    ]);
  });

  test("refuses a detail without a headline and a text that's too long", async () => {
    const rendered = await renderEditor(bodyWithCard(entryPackCard));
    const dialog = await openEditing(rendered);

    fireEvent.input(headlineField(dialog), { target: { value: "" } });
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(
        dialog.getByText(
          m.emailCampaignsBodyPassOfferDetailWithoutHeadline({}, { locale })
        )
      ).toBeTruthy()
    );
    // A headline settles the detail's issue without another submit.
    fireEvent.input(headlineField(dialog), { target: { value: "Ušetřete" } });
    await waitFor(() =>
      expect(
        dialog.queryByText(
          m.emailCampaignsBodyPassOfferDetailWithoutHeadline({}, { locale })
        ) === null
      ).toBe(true)
    );

    fireEvent.input(headlineField(dialog), {
      target: { value: "a".repeat(campaignPassOfferTextMaxLength + 1) },
    });
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(
        dialog.getByText(
          m.emailCampaignsBodyPassOfferTextInvalid(
            { max: campaignPassOfferTextMaxLength },
            { locale }
          )
        )
      ).toBeTruthy()
    );
    expect(rendered.changes).toEqual([]);
  });

  test("keeps an invalid Entry pack size until a size is chosen", async () => {
    const rendered = await renderEditor(
      bodyWithCard({ ...entryPackCard, size: 7 })
    );
    const dialog = await openEditing(rendered);

    expect(
      ["5", "10", m.emailCampaignsPassOfferSizeDefault({}, { locale })].some(
        (name) => choice(dialog, name)?.checked
      )
    ).toBe(false);
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));
    await waitFor(() =>
      expect(
        dialog.getByText(
          m.emailCampaignsBodyPassOfferSizeInvalid({}, { locale })
        )
      ).toBeTruthy()
    );
    expect(rendered.changes).toEqual([]);

    await clickChoice(dialog, "10");
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true)
    );
    expect(cardsOf(rendered.changes.at(-1))).toEqual([
      { type: "passOffer", attrs: { ...entryPackCard, size: 10 } },
    ]);
  });

  test("refuses an imported size that reads like a choice", async () => {
    const rendered = await renderEditor(
      bodyWithCard({ ...entryPackCard, size: "default" })
    );
    const dialog = await openEditing(rendered);

    expect(
      choice(dialog, m.emailCampaignsPassOfferSizeDefault({}, { locale }))
        ?.checked
    ).toBe(false);
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(
        dialog.getByText(
          m.emailCampaignsBodyPassOfferSizeInvalid({}, { locale })
        )
      ).toBeTruthy()
    );
    expect(rendered.changes).toEqual([]);
  });

  test("switching products clears an invalid size and its issue", async () => {
    const rendered = await renderEditor(
      bodyWithCard({ ...entryPackCard, size: 7 })
    );
    const dialog = await openEditing(rendered);
    const sizeInvalid = m.emailCampaignsBodyPassOfferSizeInvalid(
      {},
      { locale }
    );

    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));
    await waitFor(() => expect(dialog.getByText(sizeInvalid)).toBeTruthy());
    for (const product of [
      customerMessages.passUnlimited({}, { locale }),
      customerMessages.passEntryPack({}, { locale }),
    ]) {
      await clickChoice(dialog, product);
    }

    expect(
      choice(dialog, m.emailCampaignsPassOfferSizeDefault({}, { locale }))
        ?.checked
    ).toBe(true);
    expect(dialog.queryByText(sizeInvalid) === null).toBe(true);
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true)
    );
    expect(cardsOf(rendered.changes.at(-1))).toEqual([
      { type: "passOffer", attrs: { ...entryPackCard, size: null } },
    ]);
  });

  test("marks a card whose product is unknown until one is chosen", async () => {
    const rendered = await renderEditor(
      bodyWithCard({ product: "entry-pak", size: null })
    );
    const productInvalid = m.emailCampaignsBodyPassOfferProductInvalid(
      {},
      { locale }
    );

    expect(cardView(rendered).getByText(productInvalid)).toBeTruthy();
    const dialog = await openEditing(rendered);
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));
    await waitFor(() => expect(dialog.getByText(productInvalid)).toBeTruthy());

    await clickChoice(dialog, customerMessages.passEntryPack({}, { locale }));
    await clickChoice(dialog, "10");
    await clickIn(dialog, m.emailCampaignsPassOfferUpdate({}, { locale }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true)
    );
    expect(cardsOf(rendered.changes.at(-1))).toEqual([
      {
        type: "passOffer",
        attrs: {
          product: "entry-pack",
          size: 10,
          headline: null,
          detail: null,
        },
      },
    ]);
  });

  test("removes the card", async () => {
    const rendered = await renderEditor(bodyWithCard(entryPackCard));
    const dialog = await openEditing(rendered);

    await clickIn(dialog, m.emailCampaignsPassOfferRemove({}, { locale }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true)
    );
    expect(cardsOf(rendered.changes.at(-1))).toEqual([]);
    expect(
      rendered.view.container.querySelector("[data-pass-offer]")
    ).toBeNull();
  });
});
