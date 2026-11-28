import { Struct } from "effect";
import {
  hasReservationSelectionSearchParams,
  type ReservationSelectionSearchParams,
} from "@/features/reservation/reservation-checkout-query";
import type { WorkspaceReservationKind } from "@/features/reservation/reservation-kind";
import type { SupportedSearchParams } from "@/shared/utils";

/**
 * A reservation family's selection link: the query parameters a reservation
 * page link names, declared once.
 *
 * The parameter list decides what counts as a selection in a URL, which form
 * values a link sets, and the order a link writes its parameters in.
 */
export const defineSelectionLink = <
  const Kind extends WorkspaceReservationKind,
  const Param extends string,
  Values extends { readonly [Name in Param]?: unknown },
  Selection extends { readonly [Name in Param]?: unknown },
  ReadArgs extends readonly unknown[],
  Stored,
>(definition: {
  readonly kind: Kind;
  /** The selection parameters, in the order links name them. */
  readonly params: readonly Param[];
  /** Retired parameter names the link still reads but never writes. */
  readonly legacyParams?: readonly string[];
  /**
   * The form values a link opens with. Parameters the link leaves out or
   * names with an unusable value take the page's defaults.
   */
  readonly read: (
    searchParams: SupportedSearchParams,
    ...args: ReadArgs
  ) => Values;
  /**
   * A selection as link parameters. A parameter written as `undefined` stays
   * out of the link, so the page fills it.
   */
  readonly write: (selection: Selection) => {
    readonly [Name in Param]: string | undefined;
  };
  /** A stored reservation's selection, or `undefined` when no link can reopen it. */
  readonly fromStored: (stored: Stored) => Selection | undefined;
}) => {
  const { kind, params, read, write, fromStored } = definition;
  const namedParams = [...params, ...(definition.legacyParams ?? [])];

  const readSelection = (
    searchParams: SupportedSearchParams,
    ...args: ReadArgs
  ): Pick<Values, Param> => Struct.pick(read(searchParams, ...args), params);

  /**
   * Restored form values with the selection a URL names beside them.
   *
   * The Pay page links back to the reservation page with the signed
   * restoration token alone, so selection parameters beside that token are
   * the customer's edits after returning: any of them replaces the whole
   * restored selection, while the restoration keeps the checkout, its hold
   * replacement, the contact details, and the discount intent. Absent
   * values restore nothing.
   */
  function restore<Restored extends Pick<Values, Param>>(
    restored: Restored,
    searchParams: SupportedSearchParams,
    ...args: ReadArgs
  ): Omit<Restored, Param> & Pick<Values, Param>;
  function restore<Restored extends undefined>(
    restored: Restored,
    searchParams: SupportedSearchParams,
    ...args: ReadArgs
  ): undefined;
  function restore<Restored extends Pick<Values, Param> | undefined>(
    restored: Restored,
    searchParams: SupportedSearchParams,
    ...args: ReadArgs
  ):
    | (Omit<Exclude<Restored, undefined>, Param> & Pick<Values, Param>)
    | undefined;
  function restore<Restored extends Pick<Values, Param>>(
    restored: Restored | undefined,
    searchParams: SupportedSearchParams,
    ...args: ReadArgs
  ): (Omit<Restored, Param> & Pick<Values, Param>) | undefined {
    if (restored === undefined) return undefined;
    return hasReservationSelectionSearchParams(searchParams, namedParams)
      ? {
          ...Struct.omit(restored, params),
          ...readSelection(searchParams, ...args),
        }
      : restored;
  }

  /** A selection as link parameters, in the declared order. */
  const writeSelection = (
    selection: Selection
  ): ReservationSelectionSearchParams & {
    readonly [Name in Param]: string | undefined;
  } => {
    const ordered = { ...Struct.pick(write(selection), params) };
    // Re-inserting each parameter in declared order fixes the order a link
    // names them in, whatever order the family's writer built them in.
    for (const name of params) {
      const value = ordered[name];
      Reflect.deleteProperty(ordered, name);
      ordered[name] = value;
    }
    return ordered;
  };

  return {
    kind,
    params,
    read,
    /** The selection a link names, as form values. */
    readSelection,
    /** The selection a link names, as form fields in the declared order. */
    readFieldValues: (
      searchParams: SupportedSearchParams,
      ...args: ReadArgs
    ) => {
      const values = read(searchParams, ...args);
      return params.map((name) => ({ name, value: values[name] }));
    },
    restore,
    write: writeSelection,
    /** A stored reservation's selection, ready for a reservation page link. */
    fromStored: (
      stored: Stored
    ): ({ readonly kind: Kind } & Selection) | undefined => {
      const selection = fromStored(stored);
      return selection && { kind, ...selection };
    },
  };
};

/** A selection one family's link can name, tagged with its family. */
export type LinkedSelection<
  Link extends {
    readonly kind: WorkspaceReservationKind;
    readonly write: (selection: never) => unknown;
  },
> = { readonly kind: Link["kind"] } & Parameters<Link["write"]>[0];
