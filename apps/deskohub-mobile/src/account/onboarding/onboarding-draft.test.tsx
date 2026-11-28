import { describe, expect, test } from "bun:test";
import { RegistryContext } from "@effect/atom-react";
import { Effect, Layer, Option } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountExitFence,
  type AccountSession,
} from "../../customer-api/account-scoped-storage";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import {
  DeviceCapabilityFailed,
  DeviceOnboardingDraft,
} from "../../customer-api/device-capabilities";
import { customerDataExitCleanup } from "../../customer-api/exit-cleanup";
import {
  makeCustomerDataRegistry,
  makeFakeCustomerData,
  settle,
} from "../../customer-api/testing/customer-data-test-registry";
import {
  fakeCustomerDataLayer,
  fakeDeviceCapabilities,
} from "../../customer-api/testing/fake-customer-data";
import { completeProfileAtom } from "../profile/profile-save";
import {
  type CompletionRequiredAccount,
  saveCompletionEditsAtom,
  useOnboardingDraft,
} from "./onboarding-draft";
import {
  completionDraftRecoveryAtom,
  setOnboardingSession,
} from "./onboarding-edits";

type OnboardingDraft = ReturnType<typeof useOnboardingDraft>;

/**
 * A step of onboarding as far as its draft goes: each shown step reads and
 * edits the one completion draft through `useOnboardingDraft`. A render
 * shows the steps on screen now; a step left out has gone.
 */
const steps: Partial<Record<string, OnboardingDraft>> = {};
function Step({
  name,
  account,
}: {
  readonly name: string;
  readonly account: CompletionRequiredAccount;
}) {
  steps[name] = useOnboardingDraft(account);
  return null;
}

const step = (name: string) => {
  const found = steps[name];
  if (found === undefined) throw new Error(`step ${name} isn't mounted`);
  return found;
};

/** A completion-required account over a fake Workspace, with steps to mount. */
const onboarding = async (
  {
    registry,
    workspace,
    device,
  }: Pick<
    ReturnType<typeof makeFakeCustomerData>,
    "registry" | "workspace" | "device"
  > = makeFakeCustomerData("completion-required")
) => {
  const read = await settle(registry, accountAtom);
  const account = read._tag === "Success" ? read.success : undefined;
  if (account?.kind !== "completion-required")
    throw new Error("expected an account that needs a profile");
  const show = (...names: ReadonlyArray<string>) => {
    for (const name of Object.keys(steps)) delete steps[name];
    renderToStaticMarkup(
      <RegistryContext value={registry}>
        {names.map((name) => (
          <Step key={name} name={name} account={account} />
        ))}
      </RegistryContext>
    );
  };
  /** Waits for the submit to settle, then shows `names` again. */
  const submitted = async (...names: ReadonlyArray<string>) => {
    await Effect.runPromise(
      Effect.result(
        AtomRegistry.getResult(completeProfileAtom, {
          suspendOnWaiting: true,
        })(registry)
      )
    );
    show(...names);
  };
  const saved = () => settle(registry, saveCompletionEditsAtom);
  const restart = (session?: AccountSession) => {
    registry.dispose();
    return onboarding({
      registry: makeCustomerDataRegistry(
        fakeCustomerDataLayer({
          workspace,
          device,
          ...(session && { session }),
        })
      ),
      workspace,
      device,
    });
  };
  return { registry, workspace, device, show, submitted, saved, restart };
};

/** Edits the draft from step `name`, then shows the steps again. */
const editing =
  (show: (...names: ReadonlyArray<string>) => void) =>
  (
    name: string,
    change: Parameters<OnboardingDraft["change"]>[0],
    ...shown: ReadonlyArray<string>
  ) => {
    step(name).change(change);
    show(...(shown.length === 0 ? [name] : shown));
  };

describe("onboarding draft", () => {
  test("what About you holds is there on Billing details, and back again", async () => {
    const { show } = await onboarding();
    const edit = editing(show);
    show("about-you");
    edit("about-you", { firstName: "Jordan", phone: "+420 777 000 111" });

    show("about-you", "billing");
    expect(step("billing").draft).toMatchObject({
      firstName: "Jordan",
      phone: "+420 777 000 111",
    });
    edit(
      "billing",
      { billingKind: "personal", city: "Brno" },
      "about-you",
      "billing"
    );

    show("about-you");
    expect(step("about-you").draft).toMatchObject({
      firstName: "Jordan",
      billingKind: "personal",
      city: "Brno",
    });
  });

  test("closing onboarding and opening it again keeps the answers", async () => {
    const { show } = await onboarding();
    const edit = editing(show);
    show("about-you");
    edit("about-you", { firstName: "Jordan", lastName: "Sample" });

    show();
    show("about-you");

    expect(step("about-you").draft).toMatchObject({
      firstName: "Jordan",
      lastName: "Sample",
    });
  });

  test("restarting restores the answers from both steps", async () => {
    const before = await onboarding();
    before.show("about-you");
    editing(before.show)("about-you", { firstName: "Jordan" }, "billing");
    editing(before.show)("billing", { billingKind: "personal", city: "Brno" });
    await before.saved();
    expect(Option.getOrThrow(before.device.onboardingDraft).draft).toContain(
      "Jordan"
    );

    const after = await before.restart();
    expect(Option.isSome(after.device.onboardingDraft)).toBe(true);
    after.show("about-you", "billing");
    expect(step("about-you").draft.firstName).toBe("Jordan");
    expect(step("billing").draft.city).toBe("Brno");
  });

  test("reauthentication keeps the registry, retires old edits and saves the new session's answers", async () => {
    const { workspace, device } = makeFakeCustomerData("completion-required");
    let active = "first";
    const open = () => {
      const registry = makeCustomerDataRegistry(
        fakeCustomerDataLayer({
          workspace,
          device,
          onboardingSession: Effect.sync(() => active),
        })
      );
      setOnboardingSession(registry, active);
      return onboarding({ registry, workspace, device });
    };
    const app = await open();
    app.show("about-you");
    editing(app.show)("about-you", { firstName: "Previous" });
    await app.saved();
    const oldStep = step("about-you");

    active = "second";
    setOnboardingSession(app.registry, active);
    app.show("about-you");
    expect(step("about-you").draft.firstName).toBe("");
    app.registry.refresh(accountAtom);
    await settle(app.registry, accountAtom);
    app.show("about-you");
    editing(app.show)("about-you", { firstName: "Current" });
    oldStep.change({ firstName: "Late edit" });
    await app.saved();
    app.registry.dispose();

    const after = await open();
    after.show("about-you");
    expect(step("about-you").draft.firstName).toBe("Current");
  });

  test.each(["session confirmation", "protected storage"] as const)(
    "an edit preserves recovered fields after delayed %s",
    async (blocker) => {
      const { workspace, device } = makeFakeCustomerData("completion-required");
      let confirmed = true;
      let failRead = false;
      const normalDevice = fakeDeviceCapabilities(device);
      const draftSlot = Layer.effect(
        DeviceOnboardingDraft,
        Effect.map(Effect.service(DeviceOnboardingDraft), (storage) => ({
          ...storage,
          read: Effect.suspend(() =>
            failRead
              ? Effect.fail(
                  new DeviceCapabilityFailed({ capability: "storage" })
                )
              : storage.read
          ),
        }))
      ).pipe(Layer.provide(normalDevice));
      const open = () => {
        const registry = makeCustomerDataRegistry(
          fakeCustomerDataLayer({
            workspace,
            device,
            onboardingSession: Effect.succeed("same"),
            confirmOnboardingSession: () => Effect.sync(() => confirmed),
            capabilities: Layer.merge(normalDevice, draftSlot),
          })
        );
        setOnboardingSession(registry, "same");
        return onboarding({ registry, workspace, device });
      };
      const before = await open();
      before.show("about-you");
      editing(before.show)("about-you", { firstName: "Jordan" });
      await before.saved();
      before.registry.dispose();
      const savedDraft = device.onboardingDraft;
      confirmed = blocker !== "session confirmation";
      failRead = blocker === "protected storage";

      const during = await open();
      expect(during.registry.get(completionDraftRecoveryAtom)._tag).toBe(
        "Failure"
      );
      during.show("billing");
      step("billing").change({ billingKind: "personal", city: "Brno" });
      expect(device.onboardingDraft).toEqual(savedDraft);

      confirmed = true;
      failRead = false;
      during.registry.refresh(accountAtom);
      await settle(during.registry, accountAtom);
      expect(during.registry.get(completionDraftRecoveryAtom)._tag).toBe(
        "Success"
      );
      during.show("billing");
      editing(during.show)("billing", {
        billingKind: "personal",
        city: "Brno",
      });
      await during.saved();
      during.registry.dispose();

      const after = await open();
      after.show("about-you", "billing");
      expect(step("about-you").draft.firstName).toBe("Jordan");
      expect(step("billing").draft.city).toBe("Brno");
    }
  );

  test("a cold launch for an already-linked account erases the draft without opening onboarding", async () => {
    const before = await onboarding();
    before.show("about-you");
    editing(before.show)("about-you", { firstName: "Jordan" });
    await before.saved();
    before.registry.dispose();

    const { workspace } = makeFakeCustomerData("linked");
    const registry = makeCustomerDataRegistry(
      fakeCustomerDataLayer({ workspace, device: before.device })
    );
    const read = await settle(registry, accountAtom);
    expect(read).toMatchObject({
      _tag: "Success",
      success: { kind: "linked" },
    });
    expect(before.device.onboardingDraft).toEqual(Option.none());
  });

  test.each([
    ["another account", "new-account"],
    ["a new sign-in of the same account", undefined],
  ])(
    "starting with %s discards the previous session's draft",
    async (_, id) => {
      const before = await onboarding();
      before.show("about-you");
      editing(before.show)("about-you", { firstName: "Jordan" });
      await before.saved();

      const after = await before.restart({
        accountId: id ?? before.workspace.data.accountId,
        sessionStartedAt: 1,
      });
      after.show("about-you");
      expect(step("about-you").draft.firstName).toBe("");
      expect(after.device.onboardingDraft).toEqual(Option.none());
    }
  );

  test("sign-out removes the draft without an open onboarding view", async () => {
    const initial = makeFakeCustomerData("completion-required");
    const app = await onboarding(initial);
    app.show("about-you");
    editing(app.show)("about-you", { firstName: "Jordan" });
    await app.saved();
    expect(Option.isSome(initial.device.onboardingDraft)).toBe(true);

    app.show();
    app.registry.dispose();
    await Effect.runPromise(
      customerDataExitCleanup({
        scope: "account",
        accountId: initial.workspace.data.accountId,
        sessionStartedAt: 0,
      }).pipe(
        Effect.provide(
          Layer.merge(
            fakeDeviceCapabilities(initial.device),
            Layer.succeed(AccountExitFence, initial.fence)
          )
        )
      )
    );
    expect(initial.device.onboardingDraft).toEqual(Option.none());
  });

  test("finishing removes the saved draft even if the view closes and the account refresh fails", async () => {
    const app = await onboarding();
    app.show("about-you");
    editing(app.show)("about-you", { firstName: "Jordan" });
    await app.saved();
    expect(Option.isSome(app.device.onboardingDraft)).toBe(true);
    app.workspace.fail("getAccount", "rate-limited");

    step("about-you").submit();
    app.show();
    await app.submitted();
    expect(app.device.onboardingDraft).toEqual(Option.none());
  });

  test("switching billing kinds keeps the company typed earlier", async () => {
    const { show } = await onboarding();
    const edit = editing(show);
    show("billing");
    edit("billing", { billingKind: "business", companyName: "Sample" });
    edit("billing", { billingKind: "personal" });
    edit("billing", { billingKind: "business" });

    expect(step("billing").draft.companyName).toBe("Sample");
  });
});

describe("onboarding submit", () => {
  const both = ["about-you", "billing"] as const;

  test("Create profile sends both steps' answers in one request", async () => {
    const { show, workspace, submitted } = await onboarding();
    const edit = editing(show);
    show(...both);
    edit("about-you", { firstName: "Jordan" }, ...both);
    edit(
      "billing",
      {
        billingKind: "personal",
        addressLine1: "Sample street 1",
        city: "Brno",
        zip: "60200",
        country: "CZ",
      },
      ...both
    );

    step("billing").submit();
    await submitted(...both);

    expect(
      workspace.calls.filter((call) => call === "completeProfile")
    ).toHaveLength(1);
    expect(workspace.data.account).toMatchObject({
      kind: "linked",
      profile: {
        firstName: "Jordan",
        billing: { kind: "personal", city: "Brno" },
      },
    });
  });

  test("a failed create keeps every answer, and trying again sends them", async () => {
    const { show, workspace, submitted } = await onboarding();
    const edit = editing(show);
    show(...both);
    edit("about-you", { firstName: "Jordan" }, ...both);
    workspace.fail("completeProfile", "service-unavailable");

    step("billing").submit();
    await submitted(...both);
    expect(step("billing").state._tag).toBe("Failed");
    expect(step("about-you").draft.firstName).toBe("Jordan");
    expect(workspace.data.account.kind).toBe("completion-required");

    step("billing").submit();
    await submitted(...both);
    expect(step("billing").state._tag).toBe("Done");
    expect(workspace.data.account.kind).toBe("linked");
  });

  test("an error on About you found at the submit names that step's field", async () => {
    const { show, workspace, submitted } = await onboarding();
    const edit = editing(show);
    show(...both);
    edit("about-you", { firstName: "Jordan", referralCode: "NOPE" }, ...both);
    workspace.referralCodeAnswer = "unavailable";

    step("billing").submit();
    await submitted(...both);

    const state = step("about-you").state;
    expect(state._tag === "Invalid" && state.invalid.fields).toEqual({
      referralCode: "invalid",
    });
  });

  test("an edit after a refused submit clears its problems", async () => {
    const { show, submitted } = await onboarding();
    const edit = editing(show);
    show("billing");
    step("billing").submit();
    await submitted("billing");
    expect(step("billing").state._tag).toBe("Invalid");

    edit("billing", { firstName: "Jordan" });

    expect(step("billing").state._tag).toBe("Idle");
  });
});
