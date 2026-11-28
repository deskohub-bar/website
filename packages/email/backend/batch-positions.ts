import { Array as Arr, Effect, Option } from "effect";

/**
 * The entries a provider names by their positions in the batch request it
 * was given. A guarded provider only names positions of its own request, so
 * a position outside it is a defect, not a failure a caller handles.
 */
export const entriesAtBatchPositions = <A>(
  entries: ReadonlyArray<A>,
  positions: ReadonlyArray<number>
): Effect.Effect<ReadonlyArray<A>> =>
  Option.match(
    Option.all(
      positions.map((position) =>
        Number.isInteger(position) ? Arr.get(entries, position) : Option.none()
      )
    ),
    {
      onNone: () =>
        Effect.die(
          new RangeError("A provider named a position outside its batch")
        ),
      onSome: Effect.succeed,
    }
  );
