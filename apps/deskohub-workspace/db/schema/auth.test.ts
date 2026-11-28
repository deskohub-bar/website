import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { passkey } from "@better-auth/passkey";
import { getAuthTables } from "better-auth/db";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { authOptions } from "@/features/account/backend/auth/auth-options";
import { makeCustomerAgentAuthorizationPlugins } from "@/features/account/backend/auth/customer-agent-authorization-server";
import {
  authAccount,
  authOauthAccessToken,
  authOauthClient,
  authOauthClientAssertion,
  authOauthClientResource,
  authOauthConsent,
  authOauthRefreshToken,
  authOauthResource,
  authPasskey,
  authRateLimit,
  authSession,
  authUser,
  authVerification,
} from "./auth";

// An acronym such as the passkey `credentialID` is one word.
const snakeCase = (field: string) =>
  field.replace(/[A-Z]+/g, (word) => `_${word.toLowerCase()}`);

const drizzleAuthTables = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  rateLimit: authRateLimit,
  passkey: authPasskey,
  oauthClient: authOauthClient,
  oauthResource: authOauthResource,
  oauthClientResource: authOauthClientResource,
  oauthRefreshToken: authOauthRefreshToken,
  oauthAccessToken: authOauthAccessToken,
  oauthConsent: authOauthConsent,
  oauthClientAssertion: authOauthClientAssertion,
};

const uniqueIndexColumns = (table: PgTable) =>
  getTableConfig(table)
    .indexes.filter((index) => index.config.unique)
    .flatMap((index) => index.config.columns.map((column) => column.name));

const indexColumns = (table: PgTable) =>
  getTableConfig(table).indexes.flatMap((index) =>
    index.config.columns.map((column) => column.name)
  );

const uniqueIndexColumnGroups = (table: PgTable) =>
  getTableConfig(table)
    .indexes.filter((index) => index.config.unique)
    .map((index) => index.config.columns.map((column) => column.name));

describe("Better Auth schema", () => {
  // Keep this plugin set aligned with the runtime's auth table contributors.
  const authTables = getAuthTables({
    ...authOptions,
    plugins: [
      passkey(),
      ...makeCustomerAgentAuthorizationPlugins({
        resource: "https://workspace.example/api/mcp",
      }),
    ],
  });

  test("isolates every auth table in the auth schema", () => {
    for (const [model, table] of Object.entries(drizzleAuthTables)) {
      const config = getTableConfig(table);
      expect(config.schema).toBe("auth");
      expect(config.name).toBe(snakeCase(model));
    }
  });

  test("matches the tables Better Auth derives from the connectionless options", () => {
    expect(Object.keys(drizzleAuthTables).sort()).toEqual(
      Object.keys(authTables).sort()
    );

    for (const [model, table] of Object.entries(drizzleAuthTables)) {
      const authTable = authTables[model];
      assert(authTable, `Better Auth derives no ${model} table`);
      const config = getTableConfig(table);
      const fields = authTable.fields;

      expect(config.columns.map((column) => column.name).sort()).toEqual(
        [
          "id",
          ...Object.entries(fields).map(([key, field]) =>
            snakeCase(field.fieldName ?? key)
          ),
        ].sort()
      );

      for (const [key, field] of Object.entries(fields)) {
        const columnName = snakeCase(field.fieldName ?? key);
        const column = config.columns.find(
          (candidate) => candidate.name === columnName
        );
        assert(column, `${model} has no ${columnName} column`);

        expect(column.notNull).toBe(field.required ?? false);

        if (field.unique) {
          expect(uniqueIndexColumns(table)).toContain(columnName);
        }

        if (field.index) {
          expect(indexColumns(table)).toContain(columnName);
        }

        if (field.references) {
          const foreignKey = config.foreignKeys.find(
            (candidate) => candidate.reference().columns[0]?.name === columnName
          );
          assert(foreignKey, `${columnName} has no foreign key`);
          expect(foreignKey.onDelete).toBe(
            field.references.model === "session" ? "set null" : "cascade"
          );
          const referenced = getTableConfig(
            foreignKey.reference().foreignTable
          );
          const referencedTable = authTables[field.references.model];
          assert(
            referencedTable,
            `Better Auth derives no ${field.references.model} table`
          );
          expect(referenced.schema).toBe("auth");
          expect(referenced.name).toBe(snakeCase(referencedTable.modelName));
          expect(foreignKey.reference().foreignColumns[0]?.name).toBe(
            snakeCase(field.references.field)
          );
        }
      }
    }
  });

  test("roots every login in its durable customer account", () => {
    const [foreignKey] = getTableConfig(authUser).foreignKeys;
    expect(
      foreignKey?.reference().columns.map((column) => column.name)
    ).toEqual(["id"]);
    assert(foreignKey, "auth.user has no foreign key");
    expect(getTableConfig(foreignKey.reference().foreignTable).name).toBe(
      "customer_accounts"
    );
    expect(foreignKey.onDelete).toBe("restrict");
  });

  test("carries deletionRequestedAt as nullable server-owned user state", () => {
    const user = authTables.user;
    assert(user, "Better Auth derives no user table");
    const fields = user.fields;
    expect(fields.deletionRequestedAt).toMatchObject({
      type: "date",
      required: false,
      input: false,
    });

    const config = getTableConfig(authUser);
    const column = config.columns.find(
      (candidate) => candidate.name === "deletion_requested_at"
    );
    assert(column, "auth.user has no deletion_requested_at column");
    expect(column.notNull).toBe(false);
    expect(column.getSQLType()).toBe("timestamp with time zone");
  });

  test("carries the locale preference as a nullable server-owned user field", () => {
    const user = authTables.user;
    assert(user, "Better Auth derives no user table");
    const fields = user.fields;
    expect(fields.locale).toMatchObject({
      type: "string",
      required: false,
      input: false,
    });

    const config = getTableConfig(authUser);
    const column = config.columns.find(
      (candidate) => candidate.name === "locale"
    );
    assert(column, "auth.user has no locale column");
    expect(column.notNull).toBe(false);
    expect(column.getSQLType()).toBe("text");
    const check = config.checks.find(
      (candidate) => candidate.name === "user_locale_check"
    );
    assert(check, "auth.user has no user_locale_check");
    expect(new PgDialect().sqlToQuery(check.value).sql).toBe(
      `"auth"."user"."locale" in ('en-US', 'cs-CZ', 'de-DE', 'uk-UA', 'sk-SK', 'vi-VN', 'hi-IN')`
    );
  });

  test("keeps one passkey row per WebAuthn credential", () => {
    expect(uniqueIndexColumns(authPasskey)).toEqual(["credential_id"]);
  });

  test("keeps OAuth client/resource links unique by pair", () => {
    expect(uniqueIndexColumnGroups(authOauthClientResource)).toContainEqual([
      "client_id",
      "resource_id",
    ]);
    expect(authTables.oauthClientResource?.indexes).toContainEqual({
      fields: ["clientId", "resourceId"],
      unique: true,
    });
  });

  test("keeps timestamps decoding as Date, not Temporal", () => {
    for (const table of Object.values(drizzleAuthTables)) {
      for (const column of getTableConfig(table).columns) {
        if (column.getSQLType().startsWith("timestamp")) {
          expect(column.getSQLType()).toBe("timestamp with time zone");
          expect(column.columnType).not.toBe("PgCustomColumn");
        }
      }
    }
  });
});
