import Image from "next/image";
import { type Locale, m } from "@/features/i18n";

export interface CheckoutQrPayment {
  readonly accountNumber: string;
  readonly amount: string;
  readonly deadline: string;
  readonly expiresAt: string;
  readonly qrCodeSource: string;
  readonly variableSymbol: string;
}

export function CheckoutQrPaymentDetails({
  locale,
  payment,
  transferOnly = false,
}: {
  readonly locale: Locale;
  readonly payment: CheckoutQrPayment;
  readonly transferOnly?: boolean;
}) {
  const terms = [
    [m.checkoutQrAmount({}, { locale }), payment.amount],
    [m.checkoutQrAccount({}, { locale }), payment.accountNumber],
    [m.checkoutQrReference({}, { locale }), payment.variableSymbol],
    [
      m.checkoutQrDeadline({}, { locale }),
      <time dateTime={payment.expiresAt} key={payment.expiresAt}>
        {payment.deadline}
      </time>,
    ],
  ] as const;

  const details = (
    <dl className="grid gap-2 text-sm">
      {terms.map(([label, value]) => (
        <div className="grid gap-0.5" key={label}>
          <dt className="text-navy-blue/70">{label}</dt>
          <dd className="font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );

  if (transferOnly) return details;

  return (
    <div className="@container space-y-3 rounded-2xl border border-navy-blue/15 bg-white p-4">
      <p className="text-sm leading-6 text-navy-blue/75">
        {m.checkoutQrInstructions({}, { locale })}
      </p>
      <div className="grid items-center gap-4 @md:grid-cols-[auto_1fr]">
        <Image
          alt={m.checkoutQrImageAlt({}, { locale })}
          className="mx-auto aspect-square w-full max-w-44"
          height={176}
          src={payment.qrCodeSource}
          unoptimized
          width={176}
        />
        {details}
      </div>
    </div>
  );
}
