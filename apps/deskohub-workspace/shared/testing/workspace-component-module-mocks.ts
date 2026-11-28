import { type Mock, mock } from "bun:test";
import assert from "node:assert/strict";
import type { useWorkspaceAction } from "@/shared/utils/use-workspace-action";

export const workspaceRouterPush = mock((_href: string) => undefined);
export const workspaceRouterRefresh = mock(() => undefined);
export const workspaceRouterReplace = mock((_href: string) => undefined);
const workspaceUsePathname = mock(() => "/en-US/account");
export const workspaceUseSearchParams = mock(() => new URLSearchParams());
const workspaceUseFeatureFlagEnabled = mock(
  (_flag: string, _initialEnabled: boolean): boolean | undefined => undefined
);
const workspaceApplyFeatureFlagOverrides = mock(
  <PostHog, Overrides>(_posthog: PostHog, _overrides: Overrides) => undefined
);
const workspaceUseFeatureFlagPayload = mock(
  (_flag: string): unknown => undefined
);
const workspaceUseFeatureFlagResult = mock(
  (_flag: string): unknown => undefined
);
const workspaceUseFeatureFlagVariantKey = mock(
  (_flag: string): unknown => undefined
);
/**
 * `useWorkspaceAction` as a test double sees it: any action and options, with
 * an implementation that returns only the hook fields the component reads.
 * Without an implementation it returns `undefined`, as the default does.
 */
type WorkspaceActionHook = (
  ...args: Parameters<typeof useWorkspaceAction>
) => Partial<ReturnType<typeof useWorkspaceAction>> | undefined;

export type WorkspaceActionExecute = ReturnType<
  typeof useWorkspaceAction
>["execute"];
export const workspaceUseAction = mock<WorkspaceActionHook>();

export const submittedActionInput = <Input>(
  calls: readonly (readonly [Input])[]
): Input => {
  const lastCall = calls.at(-1);
  assert(lastCall, "The action was not submitted");
  return lastCall[0];
};

export const workspaceActionCallbacks = <Data>(
  options: Parameters<typeof useWorkspaceAction>[1],
  execute: Mock<WorkspaceActionExecute>
) => ({
  onSuccess: ({ data }: { readonly data: Data }) => {
    void options.onSuccess?.({
      data,
      input: submittedActionInput(execute.mock.calls),
    });
  },
  onError: ({
    error,
  }: {
    readonly error: { readonly serverError?: string };
  }) => {
    void options.onError?.({
      error,
      input: submittedActionInput(execute.mock.calls),
    });
  },
  onTransportError: () => {
    options.onTransportError?.({
      error: new Error("transport"),
      input: submittedActionInput(execute.mock.calls),
    });
  },
});

const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  usePathname: workspaceUsePathname,
  useRouter: () => ({
    push: workspaceRouterPush,
    refresh: workspaceRouterRefresh,
    replace: workspaceRouterReplace,
  }),
  useSearchParams: workspaceUseSearchParams,
  unstable_rethrow: (cause: unknown) => {
    throw cause;
  },
}));

mock.module("@/features/feature-flags/react", () => ({
  applyFeatureFlagOverrides: workspaceApplyFeatureFlagOverrides,
  useFeatureFlagEnabled: workspaceUseFeatureFlagEnabled,
  useFeatureFlagPayload: workspaceUseFeatureFlagPayload,
  useFeatureFlagResult: workspaceUseFeatureFlagResult,
  useFeatureFlagVariantKey: workspaceUseFeatureFlagVariantKey,
}));

mock.module("@/shared/utils/use-workspace-action", () => ({
  useWorkspaceAction: workspaceUseAction,
}));
