import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import type { Locale } from "@/features/i18n";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { CurrentWorkspaceRequestHeaders } from "@/shared/backend/workspace-request-context";
import {
  type CustomerAccountAccessError,
  customerAccountIdSchema,
} from "../customer-account";
import {
  type CustomerAccountSession,
  CustomerAuthentication,
} from "./customer-authentication.service";
import { testSessionProfile } from "./customer-authentication.test-utils";
import { findSavedLocalePreference } from "./saved-locale-preference";

/** The session cookie of the one synthetic signed-in customer. */
export const syntheticSessionCookie =
  "better-auth.session_token=synthetic-token.signature";

const syntheticAccountId = customerAccountIdSchema.make("synthetic-account");

type SavedLocalePreferenceFixture = {
  savedPreference: Locale | undefined;
  deletionRequested: boolean;
  sessionReadFailure: CustomerAccountAccessError | undefined;
  /** The cookie header each session read saw. */
  sessionReads: string[];
};

/**
 * The saved-preference reader over a fake session read. The fake session
 * read answers from the request headers the caller provides, as the
 * production read does: only a request carrying `syntheticSessionCookie` is
 * signed in, and its session carries `savedPreference`. Tests change the
 * fields of `fake` between requests.
 */
export const makeFakeSavedLocalePreference = () => {
  const fake: SavedLocalePreferenceFixture = {
    savedPreference: undefined,
    deletionRequested: false,
    sessionReadFailure: undefined,
    sessionReads: [],
  };

  const authentication = Layer.succeed(
    CustomerAuthentication,
    CustomerAuthentication.of({
      currentUser: Effect.gen(function* () {
        const headers = yield* CurrentWorkspaceRequestHeaders;
        const cookie = headers?.get("cookie") ?? "";
        fake.sessionReads.push(cookie);
        if (fake.sessionReadFailure) return yield* fake.sessionReadFailure;
        if (!cookie.includes(syntheticSessionCookie)) return null;
        return {
          accountId: syntheticAccountId,
          email: reservationCustomerEmailSchema.make(
            testEmailAddress("synthetic-account")
          ),
          ...testSessionProfile,
          deletionRequested: fake.deletionRequested,
          ...(fake.savedPreference && {
            localePreference: fake.savedPreference,
          }),
        } satisfies CustomerAccountSession;
      }),
    })
  );

  return {
    fake,
    savedLocalePreference: findSavedLocalePreference.pipe(
      Effect.provide(authentication)
    ),
  };
};
