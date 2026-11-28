import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useFeatureFlagEnabled } from "../analytics/feature-flags";
import { unneededReadAtom } from "../booking/family/booking-family-atoms";
import { useAppLocale } from "../i18n/locale-context";
import { heldPassesAtom, passCatalogAtom } from "../passes/pass-reads";
import type { AccountRelease } from "./account-gating";
import { paymentMethodsFeatureFlag } from "./account-root-model";

export const useAccountRelease = (): AccountRelease => {
  const locale = useAppLocale();
  const catalog = useAtomValue(passCatalogAtom);
  const passesReleased = AsyncResult.isSuccess(catalog);
  const passes = useAtomValue(
    passesReleased ? heldPassesAtom(locale) : unneededReadAtom
  );
  const activeCount = AsyncResult.isSuccess(passes)
    ? passes.value.held.filter(({ status }) => status === "active").length
    : undefined;
  return {
    ...(passesReleased && { passes: { activeCount } }),
    paymentMethods: useFeatureFlagEnabled(paymentMethodsFeatureFlag, false),
  };
};
