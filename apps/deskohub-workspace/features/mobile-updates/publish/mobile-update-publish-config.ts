import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  type Redacted,
  Schema,
} from "effect";

const Secret = Schema.RedactedFromValue(Schema.NonEmptyString);

/** The environment the publish script reads; CI passes each as a secret. */
const PublishEnvironment = Schema.Struct({
  /**
   * Read-write token of the public Blob store that holds update files; a
   * rollback stores no files and doesn't need it.
   */
  BLOB_READ_WRITE_TOKEN: Schema.optionalKey(Secret),
  /** The target deployment's publish token, which authorizes publishing. */
  MOBILE_UPDATES_PUBLISH_TOKEN: Secret,
  /**
   * Vercel's protection bypass for automation, needed when the target is a
   * protected preview deployment.
   */
  VERCEL_AUTOMATION_BYPASS_SECRET: Schema.optionalKey(Secret),
  /**
   * Cloud Storage bucket for update files. Setting it stores files there
   * instead of in the Blob store.
   */
  MOBILE_UPDATES_GCS_BUCKET: Schema.optionalKey(Schema.NonEmptyString),
  /** OAuth access token allowed to create and read the bucket's objects. */
  MOBILE_UPDATES_GCS_ACCESS_TOKEN: Schema.optionalKey(Secret),
  /**
   * HTTPS origin apps download Cloud Storage files from, such as a CDN in
   * front of the bucket; defaults to the bucket's public storage URL.
   */
  MOBILE_UPDATES_ASSET_ORIGIN: Schema.optionalKey(Schema.NonEmptyString),
});

/**
 * The Cloud Storage settings as set. Only storing files reads them, so a
 * rollback never fails on them.
 */
export interface CloudStorageSettings {
  readonly bucket: Option.Option<string>;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly assetOrigin: Option.Option<string>;
}

/** Where a publish run stores update files in Cloud Storage. */
interface CloudStorageAssetStore {
  readonly bucket: string;
  readonly accessToken: Redacted.Redacted<string>;
  /** Origin and path prefix of every stored file's URL, without a trailing slash. */
  readonly publicBaseUrl: string;
}

export class MobileUpdatePublishConfigInvalid extends Data.TaggedError(
  "MobileUpdatePublishConfigInvalid"
)<{ readonly message: string }> {}

interface IMobileUpdatePublishConfig {
  /** Origin of the deployment the update is published to. */
  readonly target: URL;
  readonly blobToken: Option.Option<Redacted.Redacted<string>>;
  readonly publishToken: Redacted.Redacted<string>;
  readonly protectionBypass: Option.Option<Redacted.Redacted<string>>;
  /** A bucket set here sends update files to Cloud Storage, not Blob. */
  readonly cloudStorage: CloudStorageSettings;
}

/** Where a publish run publishes to, and the secrets it publishes with. */
export class MobileUpdatePublishConfig extends Context.Service<
  MobileUpdatePublishConfig,
  IMobileUpdatePublishConfig
>()("MobileUpdatePublishConfig") {
  /**
   * Reads the secrets from the process environment. An empty variable counts
   * as unset, since GitHub Actions passes a missing secret as one.
   */
  static Default = (target: URL) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const environment = Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => value)
        );
        if (environment.MOBILE_UPDATES_PUBLISH_TOKEN === undefined) {
          return yield* new MobileUpdatePublishConfigInvalid({
            message:
              "Set MOBILE_UPDATES_PUBLISH_TOKEN to publish to a deployment",
          });
        }

        const decoded = yield* Schema.decodeUnknownEffect(PublishEnvironment)(
          environment
        ).pipe(
          Effect.mapError(
            () =>
              new MobileUpdatePublishConfigInvalid({
                message: "The mobile update publish environment is invalid",
              })
          )
        );
        return {
          target,
          cloudStorage: {
            bucket: Option.fromUndefinedOr(decoded.MOBILE_UPDATES_GCS_BUCKET),
            accessToken: Option.fromUndefinedOr(
              decoded.MOBILE_UPDATES_GCS_ACCESS_TOKEN
            ),
            assetOrigin: Option.fromUndefinedOr(
              decoded.MOBILE_UPDATES_ASSET_ORIGIN
            ),
          },
          blobToken: Option.fromUndefinedOr(decoded.BLOB_READ_WRITE_TOKEN),
          publishToken: decoded.MOBILE_UPDATES_PUBLISH_TOKEN,
          protectionBypass: Option.fromUndefinedOr(
            decoded.VERCEL_AUTOMATION_BYPASS_SECRET
          ),
        };
      })
    );
}

const bucketName = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/** The Cloud Storage bucket, token and delivery URL a publish stores files with. */
export const readCloudStorageAssetStore = Effect.fnUntraced(function* ({
  bucket,
  accessToken,
  assetOrigin,
}: CloudStorageSettings) {
  if (Option.isNone(bucket) || !bucketName.test(bucket.value)) {
    return yield* new MobileUpdatePublishConfigInvalid({
      message:
        "Set MOBILE_UPDATES_GCS_BUCKET to a bucket name to store update files in Cloud Storage",
    });
  }
  if (Option.isNone(accessToken)) {
    return yield* new MobileUpdatePublishConfigInvalid({
      message:
        "Set MOBILE_UPDATES_GCS_ACCESS_TOKEN to store update files in Cloud Storage",
    });
  }
  const publicBaseUrl = yield* readPublicBaseUrl(
    Option.getOrElse(
      assetOrigin,
      () => `https://storage.googleapis.com/${bucket.value}`
    )
  );
  return {
    bucket: bucket.value,
    accessToken: accessToken.value,
    publicBaseUrl,
  } satisfies CloudStorageAssetStore;
});

/**
 * Cloud Storage settings without a bucket would silently publish to Blob,
 * so storing files there refuses them.
 */
export const refuseCloudStorageWithoutBucket = ({
  bucket,
  accessToken,
  assetOrigin,
}: CloudStorageSettings) =>
  Option.isNone(bucket) &&
  (Option.isSome(accessToken) || Option.isSome(assetOrigin))
    ? Effect.fail(
        new MobileUpdatePublishConfigInvalid({
          message:
            "Set MOBILE_UPDATES_GCS_BUCKET to store update files in Cloud Storage",
        })
      )
    : Effect.void;

/**
 * Apps download files over HTTPS, and a file's URL is this base plus its
 * pathname, so the base can't carry credentials, a query or a fragment.
 */
const readPublicBaseUrl = (origin: string) => {
  const url = URL.parse(origin);
  return url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    !origin.includes("?") &&
    !origin.includes("#")
    ? Effect.succeed(`${url.origin}${url.pathname.replace(/\/+$/, "")}`)
    : Effect.fail(
        new MobileUpdatePublishConfigInvalid({
          message:
            "MOBILE_UPDATES_ASSET_ORIGIN must be an https URL without credentials, query or fragment",
        })
      );
};
