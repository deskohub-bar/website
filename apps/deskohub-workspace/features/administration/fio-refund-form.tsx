"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Locale } from "@/features/i18n";
import { Button } from "@/shared/components/ui/button";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import { recordFioManualRefund } from "./fio-refund-action";
import { m } from "./i18n";

export function FioRefundForm({
  locale,
  settlementId,
}: {
  readonly locale: Locale;
  readonly settlementId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const { execute, isExecuting } = useWorkspaceAction(recordFioManualRefund, {
    onSuccess: () => router.refresh(),
    onError: ({ error: actionError }) => {
      setError(
        actionError.serverError ??
          m.administrationFioRefundFailed({}, { locale })
      );
      if (actionError.serverError) router.refresh();
    },
  });

  return (
    <form
      className="mt-4 space-y-2 border-t border-navy-blue/10 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(undefined);
        execute({ settlementId });
      }}
    >
      <p className="text-sm">
        {m.administrationFioRefundInstruction({}, { locale })}
      </p>
      <Button
        disabled={isExecuting}
        size="sm"
        type="submit"
        variant="secondary"
      >
        {m.administrationFioRefundRecord({}, { locale })}
      </Button>
      <p aria-live="polite" className="text-sm text-burned-orange-ink">
        {error}
      </p>
    </form>
  );
}
