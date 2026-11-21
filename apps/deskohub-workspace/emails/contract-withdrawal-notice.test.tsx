import { expect, test } from "bun:test";
import { render } from "react-email";
import { m } from "@/features/i18n";
import { staffLocale } from "@/shared/backend/staff-locale";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import { contractWithdrawalNoticePreviewProps } from "./_fixtures/preview-props";
import {
  ContractWithdrawalNoticeEmail,
  contractWithdrawalNoticeEmailSubject,
} from "./contract-withdrawal-notice";

test("an Unlimited notice retains the statement amount and directs staff to the current refund balance", async () => {
  const { adminUrl: _reservationUrl, ...preview } =
    contractWithdrawalNoticePreviewProps;
  const props = {
    ...preview,
    contractKind: "unlimited-pass",
    contractLabel: "Unlimited pass",
    paidAmount: currencyCZK(300_000),
    refundAmount: currencyCZK(280_000),
    refundBasis: { kind: "partial", unit: "day", unstarted: 28, total: 30 },
  } as const;
  const locale = { locale: staffLocale };
  const amount = formatMoney(props.refundAmount, staffLocale).replace(
    /\s+/gu,
    " "
  );
  const subject = contractWithdrawalNoticeEmailSubject(props);
  const notice = (
    await render(<ContractWithdrawalNoticeEmail {...props} />, {
      plainText: true,
    })
  ).replace(/\s+/gu, " ");

  expect(subject).toContain(props.contractLabel);
  expect(subject.replace(/\s+/gu, " ")).not.toContain(amount);
  expect(notice).toContain(m.withdrawalNoticeCheckPassRefund({}, locale));
  expect(notice).toContain(amount);
  expect(notice).not.toContain(
    m.withdrawalNoticeActionRefund({ amount }, locale)
  );
});
