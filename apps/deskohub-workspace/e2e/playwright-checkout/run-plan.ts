import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DotyposDiscountGroupIdSchema,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { supportedLocales } from "@deskohub/i18n/locale-registry";
import { workspaceReservationIdSchema } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import { Effect, Option, Schema } from "effect";
import { storedCoworkReservationDetailsSchema } from "@/features/reservation/cowork-reservation-product";
import { storedMeetingRoomReservationDetailsSchema } from "@/features/reservation/meeting-room-reservation";
import { meetingRoomReservationDurationSchema } from "@/features/reservation/meeting-room-reservation-duration";
import { storedOfficeReservationDetailsSchema } from "@/features/reservation/office-reservation";
import { storedTableReservationDetailsSchema } from "@/features/reservation/table-reservation";
import { instantStringSchema } from "@/shared/utils/temporal";
import type { WorkspaceE2EPreparation } from "../cases";
import { writeReservationJournal } from "../reservation-journal";
import { workspaceDir, writeJsonAtomically } from "../runtime";
import type { E2ERunContext } from "../services/telemetry";
import type { CheckoutFlowState } from "../types";
import { type WorkspaceE2ECaseId, workspaceE2ECaseIds } from "./case-catalog";
import { workspaceE2ERunContextSchema } from "./run-context";

const checkoutArtifactRoot = resolve(workspaceDir, "e2e-artifacts", "checkout");
const runPlanPath = resolve(checkoutArtifactRoot, "run-plan.json");
const journalRoot = resolve(checkoutArtifactRoot, "cleanup-journals");
const formatVersion = 2;

export type WorkspaceE2ERunPlan = {
  readonly preparation?: WorkspaceE2EPreparation;
  readonly runContext: E2ERunContext;
  readonly version: typeof formatVersion;
};

const meetingRoomDetailsSchema = Schema.Struct({
  duration: meetingRoomReservationDurationSchema,
  endsAt: instantStringSchema,
  startDateTime: Schema.String,
  startsAt: instantStringSchema,
});

const officeSlotSchema = Schema.Struct({
  endsAt: instantStringSchema,
  endsOn: Schema.String,
  seats: Schema.Int,
  startsAt: instantStringSchema,
  startsOn: Schema.String,
});

const tableSlotSchema = Schema.Struct({
  date: Schema.String,
  endsAt: instantStringSchema,
  endTime: Schema.String,
  seats: Schema.Int,
  startsAt: instantStringSchema,
  startTime: Schema.String,
});

const preparationSchema = Schema.Struct({
  customerDiscountGroup: Schema.Struct({
    basisPoints: Schema.Int,
    id: DotyposDiscountGroupIdSchema,
  }),
  discounts: Schema.Struct({
    availableBasicDates: Schema.Array(Schema.String),
    availablePlusDates: Schema.Array(Schema.String),
    availableReservedDeskDates: Schema.Array(Schema.String),
  }),
  meetingRoom: Schema.Struct({
    slots: Schema.Array(
      Schema.Struct({ ...meetingRoomDetailsSchema.fields, date: Schema.String })
    ),
  }),
  office: Schema.UndefinedOr(
    Schema.Struct({ slot: officeSlotSchema, urlStateSlot: officeSlotSchema })
  ).pipe(Schema.withDecodingDefaultKey(Effect.undefined)),
  table: Schema.UndefinedOr(
    Schema.Struct({
      exclusiveForSingleTable: Schema.optionalKey(Schema.Boolean),
      slot: tableSlotSchema,
      urlStateSlot: tableSlotSchema,
    })
  ).pipe(Schema.withDecodingDefaultKey(Effect.undefined)),
});

const checkoutDataSchema = Schema.Struct({
  checkoutUrl: Schema.String,
  date: Schema.String,
  email: Schema.String,
  expectedReservationDetails: Schema.Union([
    storedCoworkReservationDetailsSchema,
    storedMeetingRoomReservationDetailsSchema,
    storedOfficeReservationDetailsSchema,
    storedTableReservationDetailsSchema,
  ]),
  locale: Schema.Literals(supportedLocales),
  meetingRoom: Schema.optionalKey(meetingRoomDetailsSchema),
  name: Schema.String,
  office: Schema.optionalKey(officeSlotSchema),
  orderIdHint: Schema.String,
  phone: Schema.String,
  table: Schema.optionalKey(
    Schema.Struct({
      ...tableSlotSchema.fields,
      checkoutInvitees: Schema.Array(Schema.String),
    })
  ),
});

const runPlanSchema = Schema.Struct({
  preparation: Schema.optionalKey(preparationSchema),
  runContext: workspaceE2ERunContextSchema,
  version: Schema.Literal(formatVersion),
});

const cleanupJournalSchema = Schema.Struct({
  caseId: Schema.Literals(workspaceE2ECaseIds),
  checkoutStates: Schema.Array(
    Schema.Struct({
      completedDotyposReservationId: Schema.optionalKey(
        DotyposReservationIdSchema
      ),
      data: checkoutDataSchema,
      orderId: Schema.optionalKey(workspaceReservationIdSchema),
      startedAt: Schema.optionalKey(Schema.DateFromString),
    })
  ),
  startedAt: Schema.DateFromString,
  version: Schema.Literal(formatVersion),
});

const decodeRunPlan = Schema.decodeOption(Schema.fromJsonString(runPlanSchema));
const decodeCleanupJournal = Schema.decodeOption(
  Schema.fromJsonString(cleanupJournalSchema)
);
type WorkspaceE2ECleanupJournal = typeof cleanupJournalSchema.Type;

export const writeWorkspaceE2ERunPlan = async (plan: WorkspaceE2ERunPlan) =>
  writeJsonAtomically(runPlanPath, plan);

export const readWorkspaceE2ERunPlan = async (
  path = runPlanPath
): Promise<WorkspaceE2ERunPlan> => parseRunPlan(await readFile(path, "utf8"));

export const writeWorkspaceE2ECaseJournal = async (
  caseId: WorkspaceE2ECaseId,
  flowStates: readonly CheckoutFlowState[],
  journalStartedAt = new Date()
) =>
  writeReservationJournal(resolve(journalRoot, `${caseId}.json`), {
    caseId,
    checkoutStates: flowStates.map(
      ({ completedDotyposReservationId, data, orderId, startedAt }) => ({
        ...(completedDotyposReservationId
          ? { completedDotyposReservationId }
          : {}),
        data,
        ...(orderId ? { orderId } : {}),
        ...(startedAt ? { startedAt: startedAt.toISOString() } : {}),
      })
    ),
    startedAt: journalStartedAt.toISOString(),
    version: formatVersion,
  } satisfies typeof cleanupJournalSchema.Encoded);

export const readWorkspaceE2ECaseJournals = async (
  caseIds: readonly WorkspaceE2ECaseId[]
): Promise<readonly CheckoutFlowState[]> => {
  const journals = await Promise.all(
    caseIds.map(async (caseId) => {
      try {
        const journal = parseCleanupJournal(
          await readFile(resolve(journalRoot, `${caseId}.json`), "utf8")
        );
        if (journal.caseId !== caseId) {
          throw new Error("Invalid workspace E2E cleanup journal");
        }
        return journal;
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return undefined;
        }
        throw cause;
      }
    })
  );

  return journals.flatMap((journal) =>
    journal
      ? journal.checkoutStates.map(
          (state): CheckoutFlowState => ({
            ...state,
            cleanupComplete: state.completedDotyposReservationId !== undefined,
            startedAt: state.startedAt ?? journal.startedAt,
          })
        )
      : []
  );
};

const parseRunPlan = (serialized: string): WorkspaceE2ERunPlan => {
  return Option.getOrThrowWith(
    decodeRunPlan(serialized),
    () => new Error("Invalid workspace E2E run plan")
  );
};

const parseCleanupJournal = (
  serialized: string
): WorkspaceE2ECleanupJournal => {
  return Option.getOrThrowWith(
    decodeCleanupJournal(serialized),
    () => new Error("Invalid workspace E2E cleanup journal")
  );
};
