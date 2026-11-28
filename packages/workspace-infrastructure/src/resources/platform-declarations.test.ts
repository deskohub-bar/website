import { describe, expect, test } from "bun:test";
import {
  productionConfig,
  sandboxConfig,
} from "../config/stack-config.test-utils";
import {
  mobileUpdatesPublisherGrant,
  mobileUpdatesPublisherReadGrant,
} from "./platform-declarations";

describe("mobile updates publisher", () => {
  test("may create and read objects on the mobile updates bucket only", () => {
    for (const config of [sandboxConfig, productionConfig]) {
      const grants = [
        mobileUpdatesPublisherGrant(config),
        mobileUpdatesPublisherReadGrant(config),
      ];
      expect(grants.map(({ id }) => id)).toEqual([
        "MobileUpdatesPublisher",
        "MobileUpdatesPublisherRead",
      ]);
      for (const { props } of grants) {
        expect(props.kind).toBe("storage.bucket");
        expect(props.name).toBe(config.mobileUpdatesBucket);
        expect(props.member).toBe(
          `serviceAccount:${config.serviceAccounts.mobileUpdatesPublisher}`
        );
      }
      expect(grants.map(({ props }) => props.role)).toEqual([
        "roles/storage.objectCreator",
        "roles/storage.legacyObjectReader",
      ]);
    }
  });

  test("never receives a role that can delete or replace objects", () => {
    const roles = [
      mobileUpdatesPublisherGrant(sandboxConfig),
      mobileUpdatesPublisherReadGrant(sandboxConfig),
    ].map(({ props }) => props.role);
    for (const role of roles) {
      expect(role).not.toMatch(
        /^roles\/storage\.(?:admin|objectAdmin|objectUser|legacyBucketOwner|legacyBucketWriter|legacyObjectOwner)$/
      );
    }
  });
});
