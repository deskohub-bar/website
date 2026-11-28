"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { CustomerSearch } from "@/features/administration/customer-search";
import { m } from "@/features/administration/i18n";
import { AdministrationAlert } from "@/features/administration/notice";
import { workspaceProductMonitorOptions } from "@/features/checkout/product-catalog";
import { m as customerMessages } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { DateInput } from "@/shared/components/date-time/date-input";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Textarea } from "@/shared/components/ui/textarea";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import { type EntryPackSize, passTiers } from "../pass-offer";
import { getPassTierName } from "../pass-offer.i18n";
import { submitPassAction } from "./pass-action";
import type { PassActionInput } from "./pass-action-input";
import {
  getPassShorteningRefund,
  type PassRefundCredit,
  passValidityEnd,
} from "./pass-adjustments";

const field = "grid gap-1.5 text-sm font-medium";
const select = "h-9 rounded-md border border-input bg-background px-3 text-sm";

type AdjustmentProps = {
  readonly passId: string;
  readonly holderAccountId: string;
  readonly holderVersion: number;
  readonly product: "entry-pack" | "unlimited";
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
  readonly earliestLastDay: PlainDate;
  readonly today: PlainDate;
  readonly paidValue: number | null;
  readonly complimentary: boolean;
  readonly refundable: boolean;
  readonly refundLimit: number;
  readonly refundCredits: readonly PassRefundCredit[];
  readonly cancellationRefund: number;
  readonly canReassign: boolean;
};

function PassActionDialog({
  title,
  description,
  submitLabel,
  children,
  beforeForm,
  adjustment,
  destructive = false,
  blocked = false,
}: {
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly children?: ReactNode;
  readonly beforeForm?: ReactNode;
  readonly adjustment: (
    data: FormData
  ) => PassActionInput["change"] | undefined;
  readonly destructive?: boolean;
  readonly blocked?: boolean;
}) {
  const locale = useRouteLocale();
  const router = useRouter();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const { execute, isExecuting } = useWorkspaceAction(submitPassAction, {
    onSuccess: ({ data }) => {
      if (!data) return;
      if (data.status === "failed") {
        setError(m.passActionsFailed({}, { locale }));
        return;
      }
      setFeedback(
        data.status === "pending"
          ? m.passActionsPending({}, { locale })
          : m.passActionsCompleted({}, { locale })
      );
      setOpen(false);
      router.refresh();
    },
    onError: ({ error: failure }) =>
      setError(failure.serverError ?? m.passActionsUnavailable({}, { locale })),
    onTransportError: () =>
      setError(m.administrationActionFailedUnexpectedly({}, { locale })),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isExecuting) return;
    const data = new FormData(event.currentTarget);
    const change = adjustment(data);
    if (!change) {
      setError(m.passActionsInvalidValidity({}, { locale }));
      return;
    }
    setError(undefined);
    execute({ change, requestId, reason: String(data.get("reason") ?? "") });
  };
  return (
    <div className="min-w-0">
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (isExecuting) return;
          if (nextOpen) {
            setRequestId(crypto.randomUUID());
            setError(undefined);
          }
          setOpen(nextOpen);
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" variant="secondary">
            {title}
          </Button>
        </DialogTrigger>
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
          locale={locale}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {blocked ? (
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  {m.passActionsClose({}, { locale })}
                </Button>
              </DialogClose>
            </DialogFooter>
          ) : (
            <>
              {beforeForm}
              <form
                aria-busy={isExecuting}
                className="grid gap-4"
                onSubmit={submit}
              >
                {/* Chromium can drop a date field's size container inside a fieldset. */}
                <div className="grid min-w-0 gap-4" inert={isExecuting}>
                  {children}
                  <label className={field} htmlFor={reasonId}>
                    {m.passActionsReason({}, { locale })}
                    <Textarea
                      id={reasonId}
                      name="reason"
                      required
                      maxLength={500}
                      rows={2}
                    />
                  </label>
                </div>
                <div role="alert">
                  {error && (
                    <AdministrationAlert status="error">
                      {error}
                    </AdministrationAlert>
                  )}
                </div>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button
                      disabled={isExecuting}
                      type="button"
                      variant="secondary"
                    >
                      {destructive
                        ? m.passActionsKeep({}, { locale })
                        : m.passActionsClose({}, { locale })}
                    </Button>
                  </DialogClose>
                  <Button
                    disabled={isExecuting}
                    type="submit"
                    variant="primary"
                    tone={destructive ? "danger" : undefined}
                  >
                    {submitLabel}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
      {feedback && (
        <p className="mt-2 text-sm" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}

function RefundField({
  value,
  onChange,
  limit,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly limit: number;
}) {
  const locale = useRouteLocale();
  const id = useId();
  return (
    <div className="grid gap-2">
      <label className={field} htmlFor={id}>
        {m.passActionsRefund({}, { locale })}
        <span className="flex items-center gap-2">
          <span>CZK</span>
          <Input
            id={id}
            className="w-32"
            min={0}
            max={Math.floor(limit / 100)}
            step={1}
            name="refund"
            type="number"
            placeholder="0"
            inputMode="numeric"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </span>
      </label>
      {Number(value) > 0 && (
        <AdministrationAlert status="warning">
          {m.passActionsNexiNote({}, { locale })}
        </AdministrationAlert>
      )}
    </div>
  );
}

function ValidityDialog({ pass }: { readonly pass: AdjustmentProps }) {
  const locale = useRouteLocale();
  const id = useId();
  const previousLastDay = Temporal.PlainDate.from(pass.validUntil)
    .subtract({ days: 1 })
    .toString();
  const [lastDay, setLastDay] = useState(previousLastDay);
  const [edited, setEdited] = useState<string>();
  const shortening = lastDay !== "" && lastDay < previousLastDay;
  const suggested =
    shortening && pass.paidValue !== null
      ? getPassShorteningRefund({
          product: pass.product,
          paid: currencyCZK(pass.paidValue),
          validFrom: pass.validFrom,
          validUntil: pass.validUntil,
          newValidUntil: passValidityEnd(plainDateStringSchema.make(lastDay)),
          credits: pass.refundCredits,
        })
      : 0;
  return (
    <PassActionDialog
      title={m.passActionsValidity({}, { locale })}
      description={
        pass.product === "unlimited"
          ? m.passActionsUnlimitedValidityDescription({}, { locale })
          : m.passActionsValidityDescription({}, { locale })
      }
      submitLabel={m.passActionsSave({}, { locale })}
      adjustment={(data) =>
        lastDay
          ? {
              _tag: "validity",
              passId: pass.passId,
              expectedValidUntil: pass.validUntil,
              lastDay,
              refundValue: shortening
                ? Number(data.get("refund") || 0) * 100
                : 0,
            }
          : undefined
      }
    >
      <label className={field} htmlFor={id}>
        {m.passActionsEndDate({}, { locale })}
      </label>
      <DateInput
        id={id}
        label={m.passActionsEndDate({}, { locale })}
        required
        minimum={pass.earliestLastDay}
        value={lastDay}
        onChange={setLastDay}
      />
      {shortening && pass.refundable && (
        <RefundField
          value={
            edited ??
            String(Math.floor(Math.min(suggested, pass.refundLimit) / 100))
          }
          onChange={setEdited}
          limit={pass.refundLimit}
        />
      )}
    </PassActionDialog>
  );
}

function CancelDialog({ pass }: { readonly pass: AdjustmentProps }) {
  const locale = useRouteLocale();
  const [edited, setEdited] = useState<string>();
  return (
    <PassActionDialog
      destructive
      title={m.passActionsCancel({}, { locale })}
      description={
        pass.product === "unlimited"
          ? [
              m.passActionsUnlimitedCancelDescription({}, { locale }),
              pass.today >= pass.validFrom &&
                pass.today < pass.validUntil &&
                m.passActionsAccessToday({}, { locale }),
            ]
              .filter(Boolean)
              .join(" ")
          : m.passActionsPackCancelDescription({}, { locale })
      }
      submitLabel={m.passActionsCancel({}, { locale })}
      adjustment={(data) => ({
        _tag: "cancel",
        passId: pass.passId,
        expectedValidUntil: pass.validUntil,
        refundValue: Number(data.get("refund") || 0) * 100,
        sendCancellationEmail: data.get("notify") === "on",
      })}
    >
      {pass.complimentary ? (
        <p className="text-sm">{m.passActionsNoRefund({}, { locale })}</p>
      ) : (
        <>
          {pass.paidValue !== null && (
            <p className="text-sm">
              {m.passActionsPaid(
                { amount: formatMoney(currencyCZK(pass.paidValue), locale) },
                { locale }
              )}
            </p>
          )}
          {pass.refundable && (
            <RefundField
              value={
                edited ??
                String(
                  Math.floor(
                    Math.min(pass.refundLimit, pass.cancellationRefund) / 100
                  )
                )
              }
              onChange={setEdited}
              limit={pass.refundLimit}
            />
          )}
        </>
      )}
      {pass.product === "entry-pack" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="notify" defaultChecked />
          {m.passActionsNotify({}, { locale })}
        </label>
      )}
    </PassActionDialog>
  );
}

function RecipientFields({
  email,
  name,
}: {
  readonly email?: string;
  readonly name?: string;
}) {
  const locale = useRouteLocale();
  const emailId = useId();
  const nameId = useId();
  return (
    <>
      <label className={field} htmlFor={emailId}>
        {m.passActionsRecipientEmail({}, { locale })}
        <Input
          id={emailId}
          name="email"
          type="email"
          autoComplete="off"
          required
          defaultValue={email}
        />
      </label>
      <label className={field} htmlFor={nameId}>
        {m.passActionsRecipientName({}, { locale })}
        <Input
          id={nameId}
          name="recipientName"
          autoComplete="off"
          maxLength={120}
          defaultValue={name}
        />
        <span className="font-normal text-muted-foreground">
          {m.passActionsRecipientNameHint({}, { locale })}
        </span>
      </label>
    </>
  );
}

const recipientFrom = (data: FormData) => {
  const recipientName = String(data.get("recipientName") ?? "").trim();
  return {
    email: String(data.get("email") ?? ""),
    ...(recipientName && { recipientName }),
  };
};

export function PassAdjustmentDialogs({
  pass,
}: {
  readonly pass: AdjustmentProps;
}) {
  const locale = useRouteLocale();
  return (
    <div className="flex flex-wrap gap-2">
      <ValidityDialog pass={pass} />
      <PassActionDialog
        blocked={!pass.canReassign}
        title={m.passActionsReassign({}, { locale })}
        description={
          pass.canReassign
            ? m.passActionsReassignDescription({}, { locale })
            : m.passActionsFirstUse({}, { locale })
        }
        submitLabel={m.passActionsReassignSubmit({}, { locale })}
        adjustment={(data) => ({
          _tag: "reassign",
          passId: pass.passId,
          expectedHolderAccountId: pass.holderAccountId,
          expectedHolderVersion: pass.holderVersion,
          ...recipientFrom(data),
        })}
      >
        <RecipientFields />
      </PassActionDialog>
      <CancelDialog pass={pass} />
    </div>
  );
}

export function GrantPassDialog({
  today,
  initialEmail,
  initialName,
}: {
  readonly today: string;
  readonly initialEmail?: string;
  readonly initialName?: string;
}) {
  const locale = useRouteLocale();
  const [recipient, setRecipient] = useState({
    email: initialEmail,
    name: initialName,
  });
  const [product, setProduct] = useState<"entry-pack" | "unlimited">(
    "entry-pack"
  );
  const [tier, setTier] = useState<(typeof passTiers)[number]>("open-space");
  const [size, setSize] = useState<EntryPackSize>(5);
  const [startDate, setStartDate] = useState(today);
  const [monitorOption, setMonitor] = useState<
    (typeof workspaceProductMonitorOptions)[number]
  >(workspaceProductMonitorOptions[0]);
  const grantSelection = (data: FormData) => {
    if (product === "entry-pack")
      return { kind: "entry-pack" as const, tier, size };
    if (tier === "open-space")
      return { tier, startDate, coffee: data.get("coffee") === "on" };
    if (tier === "reserved-desk") return { tier, startDate };
    return { tier, startDate, monitorOption };
  };
  return (
    <PassActionDialog
      title={m.passActionsGrant({}, { locale })}
      description={m.passActionsGrantDescription({}, { locale })}
      submitLabel={m.passActionsGrant({}, { locale })}
      beforeForm={
        !initialEmail && (
          <CustomerSearch
            variant="inline"
            renderCustomerAction={(customer) =>
              customer.email && (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() =>
                    setRecipient({
                      email: customer.email ?? undefined,
                      name: customer.displayName,
                    })
                  }
                >
                  {m.passActionsSelectCustomer({}, { locale })}
                </Button>
              )
            }
          />
        )
      }
      adjustment={(data) => ({
        _tag: "grant",
        ...recipientFrom(data),
        selection: grantSelection(data),
      })}
    >
      <RecipientFields
        key={recipient.email}
        email={recipient.email}
        name={recipient.name}
      />
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">
          {m.passActionsProduct({}, { locale })}
        </legend>
        {(
          [
            {
              id: "entry-pack",
              title: customerMessages.passEntryPack({}, { locale }),
              description: m.passActionsPackEntries({}, { locale }),
            },
            {
              id: "unlimited",
              title: customerMessages.passUnlimited({}, { locale }),
              description: m.passActionsUnlimitedDays({}, { locale }),
            },
          ] as const
        ).map(({ id, title, description }) => (
          <label
            className="flex cursor-pointer gap-3 rounded-lg border p-3 has-checked:border-navy-blue"
            key={id}
          >
            <input
              type="radio"
              value={id}
              name="grantProduct"
              checked={product === id}
              onChange={() => setProduct(id)}
            />
            <span className="grid gap-0.5 text-sm">
              <strong>{title}</strong>
              <span className="text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className={field}>
        {m.passActionsTier({}, { locale })}
        <select
          className={select}
          value={tier}
          onChange={(event) =>
            setTier(
              passTiers.find((candidate) => candidate === event.target.value) ??
                "open-space"
            )
          }
        >
          {passTiers.map((value) => (
            <option value={value} key={value}>
              {getPassTierName(value, locale)}
            </option>
          ))}
        </select>
      </label>
      {product === "entry-pack" ? (
        <label className={field}>
          {m.passActionsEntries({}, { locale })}
          <select
            className={select}
            value={size}
            onChange={(event) => setSize(event.target.value === "5" ? 5 : 10)}
          >
            <option value="5">5</option>
            <option value="10">10</option>
          </select>
        </label>
      ) : (
        <>
          <DateInput
            label={m.passActionsStartDate({}, { locale })}
            value={startDate}
            onChange={setStartDate}
            minimum={today}
            required
          />
          {tier === "open-space" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="coffee" />
              {m.passActionsCoffee({}, { locale })}
            </label>
          )}
          {tier === "reserved-desk-workstation" && (
            <label className={field}>
              {m.passActionsMonitor({}, { locale })}
              <select
                className={select}
                value={monitorOption}
                onChange={(event) =>
                  setMonitor(
                    workspaceProductMonitorOptions.find(
                      (value) => value === event.target.value
                    ) ?? workspaceProductMonitorOptions[0]
                  )
                }
              >
                {workspaceProductMonitorOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </PassActionDialog>
  );
}
