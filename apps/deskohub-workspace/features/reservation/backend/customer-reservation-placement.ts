import type {
  DotyposReservation,
  DotyposTable,
  DotyposTableId,
} from "@deskohub/dotypos";
import { Result } from "effect";
import {
  decodeTableSeatCapacity,
  getWorkspaceTableCandidatesByPredicate,
  isWorkspaceCoworkTableCandidate,
} from "@/features/checkout/backend/reservation";
import {
  getWorkspaceTableMap,
  type WorkspaceTableMap,
} from "@/features/checkout/workspace-table-map";
import type { StoredWorkspaceReservationDetails } from "@/features/reservation/persistence-contracts";
import { formatNamesWithNumericRanges } from "@/shared/utils/number";

/**
 * The table a customer is told to use: the table assigned to them, or the
 * shared tables an Open Space seat may take.
 */
type CustomerReservationTable = {
  readonly mode: "assigned" | "shared";
  readonly name: string;
};

/** Where a reservation sits, as its customer sees it. */
export type CustomerReservationPlacement = {
  readonly table?: CustomerReservationTable;
  /** The assigned table's room, shown only once the seating map is released. */
  readonly tableMap?: WorkspaceTableMap;
};

export const hasSharedSeating = (details: StoredWorkspaceReservationDetails) =>
  details.kind === "cowork" && details.entryTier === "open-space";

/** The assigned table's name, or its ID when the table has no name. */
const getAssignedTableName = (
  reservation: Pick<DotyposReservation, "_tableId">,
  tables: readonly DotyposTable[]
) => {
  const tableId = reservation._tableId;
  if (!tableId) return undefined;

  const tableName = tables.find((table) => table.id === tableId)?.name?.trim();

  return tableName || tableId;
};

/** Named, assignable Open Space tables whose seat capacity is usable. */
const getOpenSpaceTableNames = (
  tables: readonly DotyposTable[],
  excludedTableIds: ReadonlySet<DotyposTableId>
) =>
  getWorkspaceTableCandidatesByPredicate(tables, (tableTags) =>
    isWorkspaceCoworkTableCandidate(tableTags, { entryTier: "open-space" })
  )
    .filter(
      (table) =>
        !excludedTableIds.has(table.id) &&
        Result.isSuccess(decodeTableSeatCapacity(table))
    )
    .map((table) => table.name?.trim());

type PlacementInput = {
  readonly reservationDetails: StoredWorkspaceReservationDetails;
  readonly dotyposReservation: Pick<DotyposReservation, "_tableId">;
  readonly tables: readonly DotyposTable[];
  /** Absent when the Open Space overlap check is unavailable. */
  readonly openSpaceExcludedTableIds?: ReadonlySet<DotyposTableId>;
  readonly seatingMap: boolean;
};

const getCustomerReservationTable = (
  input: PlacementInput
): CustomerReservationTable | undefined => {
  if (hasSharedSeating(input.reservationDetails)) {
    if (!input.openSpaceExcludedTableIds) return undefined;
    const name = formatNamesWithNumericRanges(
      getOpenSpaceTableNames(input.tables, input.openSpaceExcludedTableIds)
    );
    return name ? { mode: "shared", name } : undefined;
  }

  const name = getAssignedTableName(input.dotyposReservation, input.tables);
  return name ? { mode: "assigned", name } : undefined;
};

/**
 * The customer-facing placement of a booked reservation: the table its
 * customer uses and, when `seatingMap` is released, the assigned table's room.
 */
export const getCustomerReservationPlacement = (
  input: PlacementInput
): CustomerReservationPlacement => {
  const table = getCustomerReservationTable(input);
  const tableMap = input.seatingMap
    ? getWorkspaceTableMap(input.dotyposReservation, input.tables)
    : undefined;

  return {
    ...(table && { table }),
    ...(tableMap && { tableMap }),
  };
};
