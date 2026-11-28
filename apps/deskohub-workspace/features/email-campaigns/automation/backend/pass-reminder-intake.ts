import "server-only";

import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { Data, Effect, Option, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import {
  type PassReminderCandidate,
  PassReminderReads,
  passReminderPageSize,
} from "@/features/passes/backend/pass-reminder-reads.service";
import { getPassReminderDueAt } from "@/features/passes/pass-reminder-schedule";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import { AudienceScope } from "../../backend/audience-evaluation-context";
import { CampaignCandidateRepository } from "../../backend/campaign-candidate.repository";
import { CampaignRecipientService } from "../../backend/campaign-recipient.service";
import { campaignIdSchema } from "../../campaign-identifiers";
import { automationVersionIdSchema } from "../automation-identifiers";
import {
  automationTriggerKind,
  isPassReminderTrigger,
} from "../automation-triggers";
import { versionInForce } from "../automation-versions";
import type { PassReminderContext } from "../pass-reminder-context";
import { AutomationEvaluationFacts } from "./automation-evaluation-facts.service";
import { lockAutomationForEngine } from "./automation-lifecycle-lock";
import {
  enterAutomationRuns,
  loadAutomationEntryVersions,
  takenReceiptKeys,
} from "./automation-run-entry";
import {
  AutomationUnitFetchFailure,
  type AutomationUnitHandler,
  type ClaimedAutomationUnit,
  type PlannedAutomationUnit,
  registerAutomationUnitHandler,
} from "./automation-unit-handler";
import { loadAutomationVersionActivations } from "./automation-version-activations";

const passSubject = Schema.Struct({
  passId: orderIdSchema,
  holderAccountId: customerAccountIdSchema,
  holderVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  dotyposCustomerId: DotyposCustomerIdSchema,
});

const calendarSubject = {
  campaignId: campaignIdSchema,
  versionId: automationVersionIdSchema,
  kind: Schema.Literals(["entry-pack", "unlimited"]),
  dueDate: plainDateStringSchema,
};

const subjectSchema = Schema.Union([
  Schema.TaggedStruct("Page", {
    ...calendarSubject,
    afterPassId: Schema.optionalKey(orderIdSchema),
  }),
  Schema.TaggedStruct("Candidates", {
    ...calendarSubject,
    passes: Schema.NonEmptyArray(passSubject).check(
      Schema.isMaxLength(passReminderPageSize)
    ),
  }),
]);

type Subject = typeof subjectSchema.Type;
type PageSubject = Extract<Subject, { _tag: "Page" }>;
type PassSubject = typeof passSubject.Type;

const empty = [] as const;
const encodeSubject = Schema.encodeSync(subjectSchema);
const triggerKind = (product: Subject["kind"]) =>
  product === "entry-pack"
    ? ("entry-pack-expiring" as const)
    : ("unlimited-ending" as const);

// A persisted unit retains the original fire, even when delivery crosses midnight.
const fireHasPassed = (subject: Subject, now: Temporal.Instant) =>
  Temporal.Instant.compare(getPassReminderDueAt(subject.dueDate), now) <= 0;

const receiptKey = ({ passId }: PassSubject) => `pass-reminder:${passId}`;

export const plannedPassReminderPage = (
  subject: Omit<PageSubject, "_tag">
): PlannedAutomationUnit => ({
  kind: "pass-reminder-intake",
  campaignId: subject.campaignId,
  key: `pass-reminder-page:${subject.campaignId}:${subject.versionId}:${subject.dueDate}:${subject.afterPassId ?? ""}`,
  subject: encodeSubject({ ...subject, _tag: "Page" }),
  requestCost: 0,
});

const plannedCandidateChunk = (
  subject: PageSubject,
  passes: readonly [PassSubject, ...PassSubject[]],
  requestCost: number
): PlannedAutomationUnit => ({
  kind: "pass-reminder-intake",
  campaignId: subject.campaignId,
  key: `pass-reminder-intake:${subject.campaignId}:${subject.versionId}:${subject.dueDate}:${passes[0].passId}`,
  subject: encodeSubject({
    _tag: "Candidates",
    campaignId: subject.campaignId,
    versionId: subject.versionId,
    kind: subject.kind,
    dueDate: subject.dueDate,
    passes,
  }),
  requestCost,
});

const intakeVersion = Effect.fn("passReminderIntake.version")(function* (
  subject: Subject
) {
  const versions = yield* loadAutomationEntryVersions([subject.versionId]);
  const version = versions.get(subject.versionId);
  if (
    version?.campaignId !== subject.campaignId ||
    version.purpose !== "marketing" ||
    Option.isNone(version.flow)
  ) {
    return null;
  }
  const flow = version.flow.value;
  if (
    !isPassReminderTrigger(flow.trigger) ||
    automationTriggerKind(flow.trigger) !== triggerKind(subject.kind)
  )
    return null;
  return { ...version, flow, copyVersion: flow.trigger.copyVersion ?? 1 };
});

type EntryVersion = NonNullable<
  Effect.Success<ReturnType<typeof intakeVersion>>
>;

const contextFor = (subject: Subject, now: Temporal.Instant) => ({
  now,
  campaignId: Option.some(subject.campaignId),
  trigger: Option.some({
    kind: triggerKind(subject.kind),
    at: getPassReminderDueAt(subject.dueDate),
    reservationId: Option.none(),
  }),
});

const reminderContext = (
  pass: PassReminderCandidate,
  copyVersion: PassReminderContext["copyVersion"]
): PassReminderContext => {
  const common = {
    copyVersion,
    holderAccountId: pass.holderAccountId,
    holderVersion: pass.holderVersion,
    tier: pass.tier,
    endsOn: pass.lastUsableDate,
  };
  return pass.kind === "entry-pack"
    ? {
        ...common,
        product: pass.kind,
        remainingEntries: pass.entriesLeft,
        totalEntries: pass.packSize,
      }
    : { ...common, product: pass.kind, renewalStartsOn: pass.nextPeriodStart };
};

type Fetched = Data.TaggedEnum<{
  None: Record<never, never>;
  Page: { readonly followups: readonly PlannedAutomationUnit[] };
  Candidates: { readonly admitted: readonly PassSubject[] };
}>;
const Fetched = Data.taggedEnum<Fetched>();

/** Passes use the existing bounded queue and the same flow entry as other triggers. */
export const makePassReminderIntakeHandler = Effect.gen(function* () {
  const { transaction } = yield* WorkspaceDatabase;
  const passReads = yield* PassReminderReads;
  const facts = yield* AutomationEvaluationFacts;
  const recipients = yield* CampaignRecipientService;
  const candidates = yield* CampaignCandidateRepository;
  const gate = yield* CoworkPassesReleaseGate;
  const gateDecision = gate.decision.pipe(
    Effect.mapError(
      (cause) =>
        new AutomationUnitFetchFailure({
          code: "pass-reminder-release-unavailable",
          cause,
        })
    )
  );

  const fetchPage = Effect.fn("passReminderIntake.fetchPage")(function* (
    subject: PageSubject,
    now: Temporal.Instant,
    version: EntryVersion
  ) {
    const page = yield* passReads.listDue({ ...subject, now });
    const taken = yield* transaction(
      takenReceiptKeys(subject.campaignId, page.map(receiptKey))
    );
    const pending = page.filter((pass) => !taken.has(receiptKey(pass)));
    const plan = yield* facts.plan({
      filters: { entryAudience: version.audienceFilter, reachability: true },
      context: contextFor(subject, now),
    });
    const subjects = pending.map(
      ({ passId, holderAccountId, holderVersion, dotyposCustomerId }) => ({
        passId,
        holderAccountId,
        holderVersion,
        dotyposCustomerId,
      })
    );
    const byHolder = Map.groupBy(
      subjects,
      ({ dotyposCustomerId }) => dotyposCustomerId
    );
    const chunks = yield* facts.pack({
      reads: plan.reads,
      customers: [...byHolder.keys()],
    });
    const followups = chunks.flatMap(({ customers, requestCost }) => {
      const [first, ...rest] = customers.flatMap(
        (id) => byHolder.get(id) ?? []
      );
      return first === undefined
        ? []
        : [plannedCandidateChunk(subject, [first, ...rest], requestCost)];
    });
    const last = page.at(-1);
    if (page.length === passReminderPageSize && last) {
      followups.push(
        plannedPassReminderPage({ ...subject, afterPassId: last.passId })
      );
    }
    return Fetched.Page({ followups });
  });

  const fetchCandidates = Effect.fn("passReminderIntake.fetchCandidates")(
    function* (
      subject: Extract<Subject, { _tag: "Candidates" }>,
      now: Temporal.Instant,
      version: EntryVersion
    ) {
      const context = contextFor(subject, now);
      const customers = [
        ...new Set(
          subject.passes.map(({ dotyposCustomerId }) => dotyposCustomerId)
        ),
      ];
      const plan = yield* facts.plan({
        filters: { entryAudience: version.audienceFilter, reachability: true },
        context,
      });
      const fetched = yield* facts.fetch({ reads: plan.reads, customers });
      const resolution = yield* recipients.resolve({
        purpose: "marketing",
        filter: version.audienceFilter,
        scope: AudienceScope.Customers({ ids: customers }),
        context,
        facts: fetched,
      });
      const eligible = new Set([
        ...resolution.recipients.map(
          ({ dotyposCustomerId }) => dotyposCustomerId
        ),
        ...resolution.duplicates.flatMap(
          ({ duplicateCustomerIds }) => duplicateCustomerIds
        ),
      ]);
      return Fetched.Candidates({
        admitted: subject.passes.filter(({ dotyposCustomerId }) =>
          eligible.has(dotyposCustomerId)
        ),
      });
    }
  );

  const handler: AutomationUnitHandler<Subject, Fetched> = {
    kind: "pass-reminder-intake",
    subject: subjectSchema,
    fetch: Effect.fn("passReminderIntake.fetch")(
      function* (unit: ClaimedAutomationUnit<Subject>) {
        const now = yield* currentInstant;
        const subject = unit.subject;
        if (
          unit.campaignId !== subject.campaignId ||
          !fireHasPassed(subject, now) ||
          !(yield* gateDecision)
        )
          return Fetched.None();
        const version = yield* transaction(intakeVersion(subject));
        if (version === null) return Fetched.None();
        return yield* subject._tag === "Page"
          ? fetchPage(subject, now, version)
          : fetchCandidates(subject, now, version);
      },
      Effect.mapError((cause) =>
        cause instanceof AutomationUnitFetchFailure
          ? cause
          : new AutomationUnitFetchFailure({
              code: "pass-reminder-intake",
              cause,
            })
      )
    ),
    commit: Effect.fn("passReminderIntake.commit")(
      function* (unit, fetched, now) {
        if (
          fetched._tag === "None" ||
          !(yield* gateDecision) ||
          !fireHasPassed(unit.subject, now)
        )
          return empty;
        const { campaignId, versionId, kind, dueDate } = unit.subject;
        const lifecycle = yield* lockAutomationForEngine(campaignId);
        const dueAt = getPassReminderDueAt(dueDate);
        if (
          lifecycle.status !== "active" ||
          lifecycle.acceptingSince === null ||
          Temporal.Instant.compare(lifecycle.acceptingSince, dueAt) > 0
        )
          return empty;
        const versions = yield* loadAutomationVersionActivations(campaignId);
        const inForce = versionInForce(versions, dueAt);
        if (Option.isNone(inForce) || inForce.value.id !== versionId)
          return empty;
        if (fetched._tag === "Page") return fetched.followups;
        if (fetched.admitted.length === 0) return empty;
        const version = yield* intakeVersion(unit.subject);
        if (version === null) return empty;
        const customers = yield* candidates.listCandidates({
          purpose: "marketing",
          ids: [
            ...new Set(
              fetched.admitted.map(({ dotyposCustomerId }) => dotyposCustomerId)
            ),
          ],
        });
        const permitted = new Set(
          customers.map(({ dotyposCustomerId }) => dotyposCustomerId)
        );
        const taken = yield* takenReceiptKeys(
          campaignId,
          fetched.admitted.map(receiptKey)
        );
        const current = yield* Effect.forEach(
          fetched.admitted.filter(
            (pass) =>
              permitted.has(pass.dotyposCustomerId) &&
              !taken.has(receiptKey(pass))
          ),
          (pass) =>
            passReads
              .readDue({ ...pass, kind, dueDate, now })
              .pipe(
                Effect.map(
                  Option.filter(
                    ({ dotyposCustomerId }) =>
                      dotyposCustomerId === pass.dotyposCustomerId
                  )
                )
              )
        );
        yield* enterAutomationRuns({
          campaignId,
          versionId,
          admitted: {
            flow: version.flow,
            facts,
            occurrences: current.flatMap(Option.toArray).map((pass) => ({
              dotyposCustomerId: pass.dotyposCustomerId,
              dedupKey: receiptKey(pass),
              kind: triggerKind(kind),
              at: dueAt,
              eventId: null,
              reservationId: null,
              pass: {
                id: pass.passId,
                context: reminderContext(pass, version.copyVersion),
              },
            })),
          },
          rejected: [],
          at: now,
        });
        return empty;
      }
    ),
  };

  return registerAutomationUnitHandler(handler);
});
