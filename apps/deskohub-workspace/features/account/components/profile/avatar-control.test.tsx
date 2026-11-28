import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import assert from "node:assert/strict";
import type * as avatarActions from "@/features/account/avatar-actions";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();
const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);

type UploadResult = Awaited<
  ReturnType<typeof avatarActions.uploadCustomerAvatar>
>;
type RemoveResult = Awaited<
  ReturnType<typeof avatarActions.removeCustomerAvatar>
>;

const routerRefresh = mock(() => undefined);

const existingAvatar = {
  url: "https://res.cloudinary.test/upload/v1/avatars/live",
  version: 1,
};
const defaultUpload: typeof avatarActions.uploadCustomerAvatar = () =>
  Promise.resolve({ data: { status: "uploaded", avatar: existingAvatar } });
let uploadResult = defaultUpload;
let removeResult: typeof avatarActions.removeCustomerAvatar = () =>
  Promise.resolve({ data: { status: "removed" } });
const removeCustomerAvatar = mock<typeof avatarActions.removeCustomerAvatar>(
  (input) => removeResult(input)
);

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

mock.module("@/features/account/avatar-actions", (): typeof avatarActions => ({
  uploadCustomerAvatar: (input) => uploadResult(input),
  removeCustomerAvatar,
}));

let AvatarControlForTest: typeof import("./avatar-control")["AvatarControl"];
const { m } = await import("@/features/i18n");

const renderControl = (locale: "en-US" | "cs-CZ" = "en-US") =>
  render(
    <AvatarControlForTest
      avatar={existingAvatar}
      firstName="Ada"
      lastName="Lovelace"
      locale={locale}
    />
  );

const avatarFileInput = (view: ReturnType<typeof renderControl>) => {
  const input = view.container.querySelector('input[type="file"]');
  assert(input instanceof HTMLInputElement);
  return input;
};

const chooseFile = (view: ReturnType<typeof renderControl>, file: File) => {
  fireEvent.change(avatarFileInput(view), { target: { files: [file] } });
};

describe("AvatarControl failure feedback", () => {
  beforeAll(async () => {
    ({ AvatarControl: AvatarControlForTest } = await import(
      "./avatar-control"
    ));
  });

  afterEach(() => {
    cleanup();
    uploadResult = defaultUpload;
    removeResult = () => Promise.resolve({ data: { status: "removed" } });
    removeCustomerAvatar.mockClear();
    routerRefresh.mockClear();
  });

  afterAll(async () => {
    await unregisterWorkspaceComponentTestEnv();
  });

  test("shows a localized validation error for a zero-byte file and keeps the previous image", async () => {
    uploadResult = () =>
      Promise.resolve({
        data: undefined,
        validationErrors: {
          formErrors: ["Choose an image to upload."],
          fieldErrors: {},
        },
      });

    const view = renderControl();
    expect(
      view.getByAltText(m.accountProfileAvatarAlt({}, { locale: "en-US" }))
    ).toBeDefined();

    await act(async () => {
      chooseFile(view, new File([], "empty.png", { type: "image/png" }));
    });

    await waitFor(() =>
      expect(
        view.getByText(
          m.accountProfileAvatarErrorFileMissing({}, { locale: "en-US" })
        )
      ).toBeDefined()
    );
    // The previous image is untouched.
    expect(
      view.getByAltText(m.accountProfileAvatarAlt({}, { locale: "en-US" }))
    ).toBeDefined();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  test("shows a localized generic error when the action transport rejects and keeps the previous image", async () => {
    uploadResult = () => Promise.reject(new Error("network down"));

    const view = renderControl();

    await act(async () => {
      chooseFile(
        view,
        new File(["png-bytes"], "photo.png", { type: "image/png" })
      );
    });

    await waitFor(() =>
      expect(
        view.getByText(
          m.accountProfileAvatarErrorGeneric({}, { locale: "en-US" })
        )
      ).toBeDefined()
    );
    expect(
      view.getByAltText(m.accountProfileAvatarAlt({}, { locale: "en-US" }))
    ).toBeDefined();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  test("clears a stale error when a new upload attempt starts", async () => {
    uploadResult = () => Promise.reject(new Error("network down"));

    const view = renderControl();
    await act(async () => {
      chooseFile(
        view,
        new File(["png-bytes"], "photo.png", { type: "image/png" })
      );
    });
    await waitFor(() =>
      expect(
        view.getByText(
          m.accountProfileAvatarErrorGeneric({}, { locale: "en-US" })
        )
      ).toBeDefined()
    );

    uploadResult = () =>
      new Promise(() => {
        // Pending for the rest of the test: the mutation has started.
      });
    await act(async () => {
      chooseFile(
        view,
        new File(["png-bytes"], "photo-2.png", { type: "image/png" })
      );
    });

    expect(
      view.queryByText(
        m.accountProfileAvatarErrorGeneric({}, { locale: "en-US" })
      )
    ).toBeNull();
    expect(
      view.getByText(m.accountProfileAvatarUploading({}, { locale: "en-US" }))
    ).toBeDefined();
  });

  test("a later successful remove is not masked by a previous failed upload", async () => {
    uploadResult = () => Promise.reject(new Error("network down"));

    const view = renderControl();
    await act(async () => {
      chooseFile(
        view,
        new File(["png-bytes"], "photo.png", { type: "image/png" })
      );
    });
    await waitFor(() =>
      expect(
        view.getByText(
          m.accountProfileAvatarErrorGeneric({}, { locale: "en-US" })
        )
      ).toBeDefined()
    );

    removeResult = () => Promise.resolve({ data: { status: "removed" } });
    await act(async () => {
      fireEvent.click(
        view.getByText(m.accountProfileAvatarRemove({}, { locale: "en-US" }))
      );
    });

    await waitFor(() =>
      expect(
        view.getByText(m.accountProfileAvatarRemoved({}, { locale: "en-US" }))
      ).toBeDefined()
    );
    // The stale upload failure is gone and the image was removed.
    expect(
      view.queryByText(
        m.accountProfileAvatarErrorGeneric({}, { locale: "en-US" })
      )
    ).toBeNull();
    expect(
      view.queryByAltText(m.accountProfileAvatarAlt({}, { locale: "en-US" }))
    ).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
  });

  test("a later successful upload is not masked by a previous failed remove", async () => {
    removeResult = () => Promise.reject(new Error("network down"));

    const view = renderControl();
    await act(async () => {
      fireEvent.click(
        view.getByText(m.accountProfileAvatarRemove({}, { locale: "en-US" }))
      );
    });
    await waitFor(() =>
      expect(
        view.getByText(
          m.accountProfileAvatarErrorGeneric({}, { locale: "en-US" })
        )
      ).toBeDefined()
    );
    // The failed remove keeps the previous image in place.
    expect(
      view.getByAltText(m.accountProfileAvatarAlt({}, { locale: "en-US" }))
    ).toBeDefined();

    uploadResult = () =>
      Promise.resolve({
        data: {
          status: "uploaded",
          avatar: {
            url: "https://res.cloudinary.test/upload/v2/avatars/next",
            version: 2,
          },
        },
      });
    await act(async () => {
      chooseFile(
        view,
        new File(["png-bytes"], "photo-2.png", { type: "image/png" })
      );
    });

    await waitFor(() =>
      expect(
        view.getByText(m.accountProfileAvatarUpdated({}, { locale: "en-US" }))
      ).toBeDefined()
    );
    // The stale remove failure is gone and the new image is shown.
    expect(
      view.queryByText(
        m.accountProfileAvatarErrorGeneric({}, { locale: "en-US" })
      )
    ).toBeNull();
    const image = view.getByAltText(
      m.accountProfileAvatarAlt({}, { locale: "en-US" })
    );
    expect(image.getAttribute("src")).toBe(
      "https://res.cloudinary.test/upload/v2/avatars/next"
    );
  });

  test.each([
    ["upload", "retryable outcome"],
    ["remove", "retryable outcome"],
    ["upload", "server error"],
  ] as const)(
    "keeps the previous image when a %s returns a %s",
    async (operation, failure) => {
      const failedResult = () =>
        Promise.resolve<UploadResult & RemoveResult>(
          failure === "server error"
            ? { serverError: "Your session has expired. Sign in again." }
            : { data: { status: "retryable" } }
        );
      if (operation === "upload") uploadResult = failedResult;
      else removeResult = failedResult;

      const view = renderControl();
      await act(async () => {
        if (operation === "upload") {
          chooseFile(
            view,
            new File(["png-bytes"], "photo.png", { type: "image/png" })
          );
        } else {
          fireEvent.click(
            view.getByRole("button", {
              name: m.accountProfileAvatarRemove({}, { locale: "en-US" }),
            })
          );
        }
      });

      await waitFor(() =>
        expect(view.getByRole("status").textContent).toBe(
          failure === "server error"
            ? "Your session has expired. Sign in again."
            : m.accountProfileAvatarErrorRetryable({}, { locale: "en-US" })
        )
      );
      const image = view.getByAltText(
        m.accountProfileAvatarAlt({}, { locale: "en-US" })
      );
      expect(image.getAttribute("src")).toBe(
        "https://res.cloudinary.test/upload/v1/avatars/live"
      );
      expect(
        view.getByRole("button", {
          name: m.accountProfileAvatarRemove({}, { locale: "en-US" }),
        })
      ).toBeDefined();
      expect(routerRefresh).not.toHaveBeenCalled();
    }
  );

  test("exposes the Czech upload, pending, success, and remove controls accessibly", async () => {
    const upload = Promise.withResolvers<UploadResult>();
    uploadResult = () => upload.promise;

    const view = renderControl("cs-CZ");
    const changeButton = view.getByRole("button", {
      name: m.accountProfileAvatarChange({}, { locale: "cs-CZ" }),
    });
    const fileInput = avatarFileInput(view);

    expect(changeButton.getAttribute("type")).toBe("button");
    expect(fileInput.getAttribute("accept")).toBe(".jpg,.jpeg,.png,.webp");
    expect(view.getByRole("status").textContent).toBe("");

    await act(async () => {
      chooseFile(
        view,
        new File(["image-bytes"], "photo.png", { type: "image/png" })
      );
    });

    expect(view.getByRole("status").textContent).toBe(
      m.accountProfileAvatarUploading({}, { locale: "cs-CZ" })
    );
    for (const name of [
      m.accountProfileAvatarChange({}, { locale: "cs-CZ" }),
      m.accountProfileAvatarRemove({}, { locale: "cs-CZ" }),
    ]) {
      const button = view.getByRole("button", { name });
      assert(button instanceof HTMLButtonElement);
      expect(button.disabled).toBe(true);
    }
    expect(routerRefresh).not.toHaveBeenCalled();

    await act(async () => {
      upload.resolve({
        data: {
          status: "uploaded",
          avatar: {
            url: "https://res.cloudinary.test/upload/v2/avatars/next",
            version: 2,
          },
        },
      });
    });

    expect(view.getByRole("status").textContent).toBe(
      m.accountProfileAvatarUpdated({}, { locale: "cs-CZ" })
    );
    const removeButton = view.getByRole("button", {
      name: m.accountProfileAvatarRemove({}, { locale: "cs-CZ" }),
    });
    const removal = Promise.withResolvers<RemoveResult>();
    removeResult = () => removal.promise;
    await act(async () => {
      fireEvent.click(removeButton);
    });
    expect(view.getByRole("status").textContent).toBe(
      m.accountProfileAvatarRemoving({}, { locale: "cs-CZ" })
    );
    await act(async () => {
      removal.resolve({ data: { status: "removed" } });
    });
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        m.accountProfileAvatarRemoved({}, { locale: "cs-CZ" })
      )
    );

    uploadResult = () =>
      Promise.reject(new Error("provider details stay private"));
    await act(async () => {
      chooseFile(
        view,
        new File(["image-bytes"], "retry.png", { type: "image/png" })
      );
    });
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        m.accountProfileAvatarErrorGeneric({}, { locale: "cs-CZ" })
      )
    );
  });

  test("falls back to the initials when the avatar image fails to load", async () => {
    const view = renderControl();
    const image = view.getByAltText(
      m.accountProfileAvatarAlt({}, { locale: "en-US" })
    );

    await act(async () => {
      fireEvent.error(image);
    });

    expect(
      view.queryByAltText(m.accountProfileAvatarAlt({}, { locale: "en-US" }))
    ).toBeNull();
    expect(view.getByText("AL")).toBeDefined();
  });

  test("the change control opens the file picker and clears the previous status", async () => {
    removeResult = () => Promise.resolve({ serverError: "Remove refused." });
    const view = renderControl();
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: m.accountProfileAvatarRemove({}, { locale: "en-US" }),
        })
      );
    });
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("Remove refused.")
    );
    const input = avatarFileInput(view);
    const pickerClick = mock(() => undefined);
    input.click = pickerClick;

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: m.accountProfileAvatarChange({}, { locale: "en-US" }),
        })
      );
    });

    expect(pickerClick).toHaveBeenCalledTimes(1);
    expect(view.getByRole("status").textContent).toBe("");
  });
});
