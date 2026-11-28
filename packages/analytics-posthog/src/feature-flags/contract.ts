import { flow, Option, Schema, Struct } from "effect";

export interface PostHogFeatureFlagDefinitionContract {
  readonly payload: unknown;
  readonly value: boolean | string;
}

type ValidPostHogFeatureFlagDefinitions<Definitions> = {
  readonly [Key in keyof Definitions]: PostHogFeatureFlagDefinitionContract;
};

declare const postHogFeatureFlagDefinitions: unique symbol;

export type PostHogFeatureFlagKey<Definitions> = Extract<
  keyof Definitions,
  string
>;

export type PostHogFeatureFlagValue<
  Definitions,
  Key extends PostHogFeatureFlagKey<Definitions>,
> = Definitions[Key] extends { readonly value: infer Value } ? Value : never;

export type PostHogFeatureFlagOverrides<Definitions> = Readonly<{
  [Key in PostHogFeatureFlagKey<Definitions>]?: PostHogFeatureFlagValue<
    Definitions,
    Key
  >;
}>;

export type PostHogFeatureFlagPayload<
  Definitions,
  Key extends PostHogFeatureFlagKey<Definitions>,
> = Definitions[Key] extends { readonly payload: infer Payload }
  ? Payload
  : never;

/**
 * The schemas that decode each flag's PostHog value and payload into the
 * contract's types, generated from the same definitions as those types.
 */
export type PostHogFeatureFlagDecoders<Definitions> = {
  readonly [Key in PostHogFeatureFlagKey<Definitions>]: {
    readonly payload: Schema.Decoder<
      PostHogFeatureFlagPayload<Definitions, Key>
    >;
    readonly value: Schema.Decoder<PostHogFeatureFlagValue<Definitions, Key>>;
  };
};

export interface PostHogFeatureFlagContract<
  Definitions extends ValidPostHogFeatureFlagDefinitions<Definitions>,
> {
  readonly decoders: PostHogFeatureFlagDecoders<Definitions>;
  readonly keys: readonly PostHogFeatureFlagKey<Definitions>[];
  readonly [postHogFeatureFlagDefinitions]?: Definitions;
}

export const definePostHogFeatureFlags = <
  const Definitions extends ValidPostHogFeatureFlagDefinitions<Definitions>,
>(
  decoders: PostHogFeatureFlagDecoders<Definitions>
): PostHogFeatureFlagContract<Definitions> => ({
  decoders,
  keys: Struct.keys(decoders),
});

/**
 * Decodes the SDK's value for `key` into the contract's value, or
 * `undefined` when PostHog returns none or one the contract does not declare.
 */
export const decodePostHogFeatureFlagValue = <
  Definitions extends ValidPostHogFeatureFlagDefinitions<Definitions>,
  Key extends PostHogFeatureFlagKey<Definitions>,
>(
  contract: PostHogFeatureFlagContract<Definitions>,
  key: Key
) =>
  flow(
    Schema.decodeUnknownOption(contract.decoders[key].value),
    Option.getOrUndefined
  );

/**
 * Decodes the SDK's payload for `key` into the contract's payload, or
 * `undefined` when PostHog returns none or one the contract does not declare,
 * so an edit in PostHog cannot hand callers a payload of another shape.
 * Excess fields fail the decode, so a union of payload shapes matches the
 * shape that declares every field instead of the first one that fits.
 */
export const decodePostHogFeatureFlagPayload = <
  Definitions extends ValidPostHogFeatureFlagDefinitions<Definitions>,
  Key extends PostHogFeatureFlagKey<Definitions>,
>(
  contract: PostHogFeatureFlagContract<Definitions>,
  key: Key
) =>
  flow(
    Schema.decodeUnknownOption(contract.decoders[key].payload, {
      onExcessProperty: "error",
    }),
    Option.getOrUndefined
  );

/**
 * Each contract flag's constant value when its definitions were read, as
 * classified by `getConstantEnabledValue`: `null` when the value depends on
 * the request.
 */
export interface PostHogFeatureFlagSnapshot<Key extends string = string> {
  /** ISO 8601 instant at which the definitions were read. */
  readonly generatedAt: string;
  readonly constantValues: Readonly<Record<Key, boolean | null>>;
}
