"use client";

import { Predicate } from "effect";
import type { FeatureFlagResult } from "posthog-js";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  decodePostHogFeatureFlagPayload,
  decodePostHogFeatureFlagValue,
  type PostHogFeatureFlagContract,
  type PostHogFeatureFlagDefinitionContract,
  type PostHogFeatureFlagKey,
  type PostHogFeatureFlagOverrides,
  type PostHogFeatureFlagPayload,
  type PostHogFeatureFlagValue,
} from "./contract";

type ValidDefinitions<Definitions> = {
  readonly [Key in keyof Definitions]: PostHogFeatureFlagDefinitionContract;
};

interface PostHogFeatureFlagOverrideClient<Definitions> {
  readonly featureFlags: {
    readonly overrideFeatureFlags: (
      overrides:
        | false
        | {
            readonly flags: PostHogFeatureFlagOverrides<Definitions>;
          }
    ) => void;
  };
}

export type TypedPostHogFeatureFlagResult<
  Definitions,
  Key extends PostHogFeatureFlagKey<Definitions>,
> = Omit<FeatureFlagResult, "key" | "payload" | "variant"> & {
  readonly key: Key;
  readonly payload: PostHogFeatureFlagPayload<Definitions, Key> | undefined;
  readonly variant:
    | (PostHogFeatureFlagValue<Definitions, Key> & string)
    | undefined;
};

/** The browser SDK reads behind the flag hooks. */
export interface PostHogFeatureFlagClient {
  getFeatureFlag(key: string): boolean | string | undefined;
  getFeatureFlagResult(
    key: string,
    options?: { readonly send_event?: boolean }
  ): FeatureFlagResult | undefined;
  isFeatureEnabled(key: string): boolean | undefined;
  onFeatureFlags(callback: () => void): () => void;
}

/**
 * The browser SDK client once it is available. It can arrive after the hooks
 * mount, for example when the SDK loads only after analytics consent.
 */
export interface PostHogClientSource {
  readonly getClient: () => PostHogFeatureFlagClient | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

const unavailableClient: PostHogClientSource = {
  getClient: () => undefined,
  subscribe: () => () => undefined,
};

const PostHogClientContext =
  createContext<PostHogClientSource>(unavailableClient);

// `@posthog/react` imports the whole browser SDK at module load, so the hooks
// read the client from this context instead, with the same semantics.
export function PostHogClientProvider({
  children,
  client,
}: {
  readonly children: ReactNode;
  readonly client: PostHogClientSource;
}) {
  return createElement(
    PostHogClientContext.Provider,
    { value: client },
    children
  );
}

/** Reads a flag value, then again whenever the client or its flags change. */
/**
 * Reads `flag` from the current client and rereads it whenever PostHog
 * reloads flags. The state keeps the flag it was read for, so a render
 * after `flag` changes never returns the previous flag's value.
 */
const useFeatureFlagRead = <Flag extends string, Value>(
  flag: Flag,
  read: (client: PostHogFeatureFlagClient, flag: Flag) => Value | undefined
): Value | undefined => {
  const source = useContext(PostHogClientContext);
  const readCurrent = (currentFlag: Flag) => {
    const client = source.getClient();
    return client === undefined ? undefined : read(client, currentFlag);
  };
  const [state, setState] = useState(() => ({
    flag,
    value: readCurrent(flag),
  }));

  useEffect(() => {
    let unsubscribeFlags: (() => void) | undefined;
    const attachClient = () => {
      unsubscribeFlags?.();
      unsubscribeFlags = undefined;
      const client = source.getClient();
      if (client === undefined) return;

      setState({ flag, value: read(client, flag) });
      unsubscribeFlags = client.onFeatureFlags(() =>
        setState({ flag, value: read(client, flag) })
      );
    };

    attachClient();
    const unsubscribeSource = source.subscribe(attachClient);
    return () => {
      unsubscribeSource();
      unsubscribeFlags?.();
    };
  }, [flag, read, source]);

  return state.flag === flag ? state.value : readCurrent(flag);
};

const readEnabled = (client: PostHogFeatureFlagClient, flag: string) =>
  client.isFeatureEnabled(flag);

export const createPostHogReactFeatureFlags = <
  const Definitions extends ValidDefinitions<Definitions>,
>(
  contract: PostHogFeatureFlagContract<Definitions>
) => {
  const readResult = <Key extends PostHogFeatureFlagKey<Definitions>>(
    client: PostHogFeatureFlagClient,
    flag: Key
  ): TypedPostHogFeatureFlagResult<Definitions, Key> | undefined => {
    const result = client.getFeatureFlagResult(flag);
    if (result === undefined || result.key !== flag) return undefined;

    const variant = decodePostHogFeatureFlagValue(
      contract,
      flag
    )(result.variant);
    return {
      ...result,
      key: flag,
      payload: decodePostHogFeatureFlagPayload(contract, flag)(result.payload),
      variant: Predicate.isString(variant) ? variant : undefined,
    };
  };

  const readVariantKey = <Key extends PostHogFeatureFlagKey<Definitions>>(
    client: PostHogFeatureFlagClient,
    flag: Key
  ) =>
    decodePostHogFeatureFlagValue(contract, flag)(client.getFeatureFlag(flag));

  const readPayload = <Key extends PostHogFeatureFlagKey<Definitions>>(
    client: PostHogFeatureFlagClient,
    flag: Key
  ) =>
    decodePostHogFeatureFlagPayload(
      contract,
      flag
    )(client.getFeatureFlagResult(flag, { send_event: false })?.payload);

  function useFeatureFlagEnabled<
    Key extends PostHogFeatureFlagKey<Definitions>,
  >(flag: Key): boolean | undefined;
  function useFeatureFlagEnabled<
    Key extends PostHogFeatureFlagKey<Definitions>,
  >(flag: Key, defaultValue: boolean): boolean;
  function useFeatureFlagEnabled<
    Key extends PostHogFeatureFlagKey<Definitions>,
  >(flag: Key, defaultValue?: boolean) {
    return useFeatureFlagRead(flag, readEnabled) ?? defaultValue;
  }

  function useFeatureFlagResult<Key extends PostHogFeatureFlagKey<Definitions>>(
    flag: Key
  ) {
    return useFeatureFlagRead(flag, readResult);
  }

  function useFeatureFlagVariantKey<
    Key extends PostHogFeatureFlagKey<Definitions>,
  >(flag: Key) {
    return useFeatureFlagRead(flag, readVariantKey);
  }

  function useFeatureFlagPayload<
    Key extends PostHogFeatureFlagKey<Definitions>,
  >(flag: Key) {
    return useFeatureFlagRead(flag, readPayload);
  }

  const applyFeatureFlagOverrides = (
    client: PostHogFeatureFlagOverrideClient<Definitions>,
    overrides?: PostHogFeatureFlagOverrides<Definitions>
  ) => {
    client.featureFlags.overrideFeatureFlags(
      overrides === undefined
        ? false
        : {
            flags: overrides,
          }
    );
  };

  return {
    applyFeatureFlagOverrides,
    useFeatureFlagEnabled,
    useFeatureFlagPayload,
    useFeatureFlagResult,
    useFeatureFlagVariantKey,
  };
};
