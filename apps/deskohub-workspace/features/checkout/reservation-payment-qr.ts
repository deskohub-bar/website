import { type Money, moneyToDecimalString } from "@/shared/money/money";

export interface ReservationPaymentAccount {
  readonly accountNumber: string;
  readonly accountPrefix?: string;
  readonly bankCode: string;
}

export const createReservationPaymentQrPayload = ({
  account,
  amount,
  variableSymbol,
}: {
  readonly account: ReservationPaymentAccount;
  readonly amount: Money;
  readonly variableSymbol: string;
}) => {
  const bban = `${account.bankCode}${(account.accountPrefix ?? "").padStart(6, "0")}${account.accountNumber.padStart(10, "0")}`;
  // The IBAN checksum moves CZ00 to the end, where C = 12 and Z = 35.
  const checkDigits = String(98n - (BigInt(`${bban}123500`) % 97n)).padStart(
    2,
    "0"
  );
  return `SPD*1.0*ACC:CZ${checkDigits}${bban}*AM:${moneyToDecimalString(amount)}*CC:CZK*X-VS:${variableSymbol}`;
};
