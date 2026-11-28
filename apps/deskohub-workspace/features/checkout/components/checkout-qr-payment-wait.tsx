import { useAtomValue } from "@effect/atom-react";
import { Effect, Stream } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { Clock3, TriangleAlert } from "lucide-react";
import { useReducedMotion } from "motion/react";
import Link from "next/link";
import {
  type CSSProperties,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import { type Locale, m } from "@/features/i18n";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils";
import {
  type CheckoutQrPayment,
  CheckoutQrPaymentDetails,
} from "./checkout-qr-payment-details";
import styles from "./checkout-qr-payment-wait.module.css";
import {
  CheckoutStatusAnnouncement,
  CheckoutStatusHeadline,
} from "./checkout-status-headline";

const SECOND = 1000;
const FIRST_WAIT = 60 * SECOND;
const SECOND_WAIT = 5 * FIRST_WAIT;
const SUPPORT_AFTER = FIRST_WAIT + SECOND_WAIT;

const getWaitPhase = (elapsed: number) => {
  if (elapsed < FIRST_WAIT) return "waiting";
  return elapsed < SUPPORT_AFTER ? "delayed" : "support";
};

const createWaitClock = (startedAt: number) =>
  Atom.make(
    Stream.unwrap(
      Effect.sync(() => {
        const ticks = Stream.fromEffectRepeat(
          Effect.suspend(() =>
            Effect.sync(Date.now).pipe(
              Effect.delay(
                SECOND - (Math.max(0, Date.now() - startedAt) % SECOND)
              )
            )
          )
        );
        const resume = Stream.merge(
          Stream.fromEventListener(document, "visibilitychange"),
          Stream.fromEventListener(window, "pageshow")
        ).pipe(Stream.map(() => Date.now()));

        return Stream.merge(ticks, resume).pipe(
          Stream.takeUntil((now) => now >= startedAt + SUPPORT_AFTER)
        );
      })
    ),
    { initialValue: Date.now() }
  );

export function CheckoutQrPaymentWait({
  headingRef,
  locale,
  payment,
  startedAt,
  supportHref,
}: {
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly locale: Locale;
  readonly payment: CheckoutQrPayment;
  readonly startedAt: number;
  readonly supportHref: string;
}) {
  const [clock] = useState(() => createWaitClock(startedAt));
  const now = AsyncResult.getOrElse(useAtomValue(clock), Date.now);
  const phase = getWaitPhase(now - startedAt);
  const { title: titleMessage, warning } = {
    waiting: { title: m.checkoutQrWaitTitle, warning: undefined },
    delayed: {
      title: m.checkoutQrWaitDelayedTitle,
      warning: m.checkoutQrWaitCheckBank,
    },
    support: {
      title: m.checkoutQrWaitSupportTitle,
      warning: m.checkoutQrWaitAvoidDoublePayment,
    },
  }[phase];
  const title = titleMessage({}, { locale });

  return (
    <>
      <CheckoutStatusAnnouncement locale={locale} title={title} />
      <CheckoutStatusHeadline
        copy={{
          Icon: Clock3,
          title,
          tone: "pending",
          lead:
            phase === "support"
              ? m.checkoutQrWaitSupportLead(
                  { deadline: payment.deadline },
                  { locale }
                )
              : m.checkoutQrWaitingLead({}, { locale }),
        }}
        headingRef={headingRef}
        locale={locale}
        reviewSandbox={false}
        showSupportButton={false}
      />
      {phase !== "support" && (
        <CheckoutQrWaitCountdown
          duration={phase === "waiting" ? FIRST_WAIT : SECOND_WAIT}
          locale={locale}
          now={now}
          startedAt={startedAt + (phase === "waiting" ? 0 : FIRST_WAIT)}
          tone={phase === "waiting" ? "navy" : "amber"}
        />
      )}
      {warning && (
        <p
          className={cn(
            "mb-4 flex items-center justify-center gap-2 rounded-2xl border border-amber-600/40 bg-amber-100 px-4 py-3 text-center text-balance text-amber-950",
            phase === "support" && "mt-6"
          )}
        >
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          {warning({}, { locale })}
        </p>
      )}
      {phase === "support" && (
        <Button asChild className="mb-4" fullWidth size="lg" wrap>
          <Link href={supportHref} prefetch={false}>
            {m.checkoutQrWaitContactSupport({}, { locale })}
          </Link>
        </Button>
      )}
      <details className="border-navy-blue/15 border-t">
        <summary className="cursor-pointer rounded-sm py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-burned-orange">
          {m.checkoutQrWaitShowDetails({}, { locale })}
        </summary>
        <CheckoutQrPaymentDetails
          locale={locale}
          payment={payment}
          transferOnly
        />
      </details>
    </>
  );
}

function CheckoutQrWaitCountdown({
  duration,
  locale,
  now,
  startedAt,
  tone,
}: {
  readonly duration: number;
  readonly locale: Locale;
  readonly now: number;
  readonly startedAt: number;
  readonly tone: "navy" | "amber";
}) {
  const ring = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const element = ring.current;
    if (!element || reducedMotion) return;

    let frame: number;
    const draw = () => {
      const progress = Math.min(
        1,
        Math.max(0, Date.now() - startedAt) / duration
      );
      element.style.setProperty("--qr-wait-motion-progress", String(progress));
      if (progress < 1) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      element.style.removeProperty("--qr-wait-motion-progress");
    };
  }, [duration, reducedMotion, startedAt]);

  const remaining = Math.ceil(
    (duration - Math.max(0, now - startedAt)) / SECOND
  );
  const digits = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const style: CSSProperties & { "--qr-wait-step-progress": number } = {
    "--qr-wait-step-progress": 1 - (remaining * SECOND) / duration,
  };

  return (
    <div className="mt-10 mb-8 grid place-items-center">
      <div className={styles.ring} data-tone={tone} ref={ring} style={style}>
        <div className="z-10 grid justify-items-center gap-1 text-center">
          <span
            aria-label={m.checkoutQrWaitCountdown({ time: digits }, { locale })}
            className="text-4xl font-medium tabular-nums"
            role="timer"
          >
            {digits}
          </span>
          <span aria-hidden="true" className="max-w-24 text-xs leading-tight">
            {m.checkoutQrWaitCountdownLabel({}, { locale })}
          </span>
        </div>
      </div>
    </div>
  );
}
