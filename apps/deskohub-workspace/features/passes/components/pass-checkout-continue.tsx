import type { Locale } from "@/features/i18n";
import { ReservationSubmitSection } from "@/features/reservation/components/reservation-submit-section";

export function PassCheckoutContinue({
  locale,
  pending = false,
  disabled = false,
}: {
  readonly locale: Locale;
  readonly pending?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <ReservationSubmitSection
      continues
      disabled={pending || disabled}
      isAvailabilityLoading={false}
      isPriceLoading={false}
      locale={locale}
      onRetryPrice={() => {}}
      priceError={false}
      retryingPrice={false}
    />
  );
}
