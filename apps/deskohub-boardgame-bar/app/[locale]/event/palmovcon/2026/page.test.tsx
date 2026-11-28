import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { getLocale, setLocale } from "@/features/i18n";
import { setBoardgameTestEnv } from "@/shared/testing/boardgame-test-env";

const initialLocale = getLocale();

afterEach(() => {
  setSystemTime();
  setLocale(initialLocale, { reload: false });
});

test("the Palmovcon 2026 page returns 404 once the event is over", async () => {
  setBoardgameTestEnv();
  mock.module("server-only", () => ({}));
  const nextServer = await import("next/server");
  mock.module("next/server", () => ({
    ...nextServer,
    connection: async () => {},
  }));
  const getCloudinaryImageByPublicId = mock(async () => undefined);
  mock.module(
    "@/features/gallery/backend/get-cloudinary-image-by-public-id.server",
    () => ({ getCloudinaryImageByPublicId })
  );

  const { default: Palmovcon2026Page } = await import("./page");
  setSystemTime(new Date("2026-07-19T22:00:00.000Z"));

  await expect(
    Palmovcon2026Page({
      params: Promise.resolve({ locale: "cs-CZ" }),
    } as Parameters<typeof Palmovcon2026Page>[0])
  ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  expect(getCloudinaryImageByPublicId).not.toHaveBeenCalled();
});
