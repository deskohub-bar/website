import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { CliSessionId } from "@deskohub/workspace-admin-api";
import { m } from "@/features/administration/i18n";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import {
  workspaceRouterRefresh,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

mock.module("./actions", () => ({
  approveCliAuthentication: mock(),
  renameCliSession: mock(),
  revokeCliSession: mock(),
}));

registerWorkspaceComponentTestEnv();
// React DOM, which @testing-library/react loads, must load after the
// happy-dom registration to handle input events.
const { act, cleanup, fireEvent, render } = await import(
  "@testing-library/react"
);
const { RenameCliSession } = await import("./rename-cli-session");

const sessionId = CliSessionId.make("019f70bd-0131-7f30-9f8a-48e768f00292");
const execute = mock();

beforeEach(() => {
  execute.mockReset();
  workspaceUseAction.mockImplementation(() => ({
    execute,
    isExecuting: false,
  }));
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  workspaceUseAction.mockReset();
  await unregisterWorkspaceComponentTestEnv();
});

test("labels the close button in Czech on a Czech route", async () => {
  const view = render(
    <RouteLocaleProvider locale="cs-CZ">
      <RenameCliSession clientName="Office Mac" sessionId={sessionId} />
    </RouteLocaleProvider>
  );

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Přejmenovat" }));
  });

  expect(view.getByRole("button", { name: "Zavřít" })).toBeTruthy();
});

describe("client name rule", () => {
  const locale = "en-US";

  // Opens the dialog, enters the client name, and submits it.
  const submitClientName = async (clientName: string) => {
    const view = render(
      <RouteLocaleProvider locale={locale}>
        <RenameCliSession clientName="Office Mac" sessionId={sessionId} />
      </RouteLocaleProvider>
    );
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: m.adminCliRenameTrigger({}, { locale }),
        })
      );
    });
    const input = view.getByLabelText(m.adminCliRenameLabel({}, { locale }));
    await act(async () => {
      fireEvent.input(input, { target: { value: clientName } });
    });
    const form = input.closest("form");
    if (!form) throw new Error("Rename form missing");
    await act(async () => {
      fireEvent.submit(form);
    });
    return view;
  };

  test("renames the session to a valid client name", async () => {
    await submitClientName("Studio laptop");

    expect(execute).toHaveBeenCalledWith({
      clientName: "Studio laptop",
      sessionId,
    });
  });

  test("asks for a client name when it's blank", async () => {
    const view = await submitClientName("   ");

    expect(
      view.getByText(m.adminCliRenameLabelRequired({}, { locale }))
    ).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects a client name longer than the contract allows", async () => {
    const view = await submitClientName("x".repeat(81));

    expect(
      view.getByText(m.adminCliRenameLabelTooLong({}, { locale }))
    ).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });
});

test("reports a failed rename and closes the dialog after a successful one", async () => {
  type RenameCallbacks = Parameters<typeof workspaceUseAction>[1];
  let callbacks: RenameCallbacks | undefined;
  workspaceUseAction.mockImplementation((_action, options) => {
    callbacks = options;
    return { execute, isExecuting: false };
  });
  workspaceRouterRefresh.mockClear();
  const locale = "en-US";
  const view = render(
    <RouteLocaleProvider locale={locale}>
      <RenameCliSession clientName="Office Mac" sessionId={sessionId} />
    </RouteLocaleProvider>
  );
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: m.adminCliRenameTrigger({}, { locale }),
      })
    );
  });
  const settle = (run: (settled: RenameCallbacks) => void) =>
    act(() => {
      if (!callbacks) throw new Error("Rename action was not set up");
      run(callbacks);
    });
  const alertText = () => view.queryByRole("alert")?.textContent;

  settle(({ onError }) => {
    if (!onError) throw new Error("Expected onError callback");
    onError({ error: { serverError: "Server says" }, input: undefined });
  });
  expect(alertText()).toBe("Server says");
  settle(({ onTransportError }) => {
    if (!onTransportError)
      throw new Error("Expected onTransportError callback");
    onTransportError({ error: new Error("transport"), input: undefined });
  });
  expect(alertText()).toBe(m.adminCliRenameFailed({}, { locale }));
  settle(({ onError }) => {
    if (!onError) throw new Error("Expected onError callback");
    onError({ error: { serverError: "Server says" }, input: undefined });
  });
  expect(alertText()).toBe("Server says");
  settle(({ onError }) => {
    if (!onError) throw new Error("Expected onError callback");
    onError({ error: {}, input: undefined });
  });
  expect(alertText()).toBe(m.adminCliRenameFailed({}, { locale }));

  settle(({ onSuccess }) => {
    if (!onSuccess) throw new Error("Expected onSuccess callback");
    onSuccess({ data: undefined, input: undefined });
  });
  expect(view.queryByRole("dialog")).not.toBeNull();
  expect(workspaceRouterRefresh).not.toHaveBeenCalled();

  settle(({ onSuccess }) => {
    if (!onSuccess) throw new Error("Expected onSuccess callback");
    onSuccess({ data: { renamed: true }, input: undefined });
  });
  expect(view.queryByRole("dialog")).toBeNull();
  expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
});
