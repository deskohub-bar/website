import { afterAll, describe, expect, expectTypeOf, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  SchemaGetter,
  Struct,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
} from "effect/http-api";
import {
  administrationOperations,
  destructiveOperation,
  readOperation,
  writeOperation,
} from "./administration-operation";
import {
  defineOperations,
  mutation,
  type Operation,
  type OperationInput,
  query,
} from "./administration-operation-port";
import { NoInput } from "./campaign-operations";
import { DhwVersion, MinimumDhwVersion } from "./dhw-version";
import {
  bareRequest,
  bodyRequest,
  type OperationGroupServer,
  type OperationRequest,
  operationGroup,
  operationGroupHandlers,
  operationHandler,
  operationRequest,
  paramsBodyRequest,
  paramsFieldRequest,
  paramsQueryRequest,
  paramsRequest,
  queryRequest,
  type SelfNamedOperations,
  type ServedOperationOptions,
  servesOperation,
} from "./operation-endpoints";
import {
  AdministrationAccountId,
  AdministrationActionRecord,
  AdministrationAuthentication,
  administrationOperationGroupCheckingDhwFirst,
  CliClientCompatibility,
  CliInputInvalid,
  CliMutationRequestId,
  CliSessionId,
  CurrentAdministrationCaller,
} from "./workspace-admin-api";

const strictParseOptions = {
  parseOptions: { errors: "all", onExcessProperty: "error" },
} as const;

const NoteId = Schema.NonEmptyString;
const NoteRef = Schema.Struct({ noteId: NoteId }).annotate(strictParseOptions);
/** Each operation answers with the input it received, as JSON. */
const ReceivedInput = Schema.String;

const noteOperations = defineOperations({
  listNotes: query({ input: NoInput, output: ReceivedInput }),
  getNote: query({ input: NoteRef, output: ReceivedInput }),
  searchNotes: query({
    input: Schema.Struct({
      folderId: NoteId,
      text: Schema.optionalKey(Schema.String),
    }).annotate(strictParseOptions),
    output: ReceivedInput,
  }),
  createNote: mutation({
    input: Schema.Struct({
      requestId: CliMutationRequestId,
      text: Schema.String,
    }).annotate(strictParseOptions),
    output: ReceivedInput,
    ledger: true,
  }),
  editNote: mutation({
    input: Schema.Struct({ noteId: NoteId, text: Schema.String }).annotate(
      strictParseOptions
    ),
    output: ReceivedInput,
  }),
  archiveNote: mutation({ input: NoteRef, output: ReceivedInput }),
  renameNote: mutation({
    input: Schema.Struct({
      noteId: NoteId,
      title: Schema.optionalKey(Schema.String),
    }).annotate(strictParseOptions),
    output: ReceivedInput,
  }),
  previewNote: query({
    input: Schema.Struct({
      noteId: NoteId,
      draft: Schema.Union([
        Schema.Struct({ text: Schema.String }),
        Schema.Struct({ copyOf: NoteId }),
      ]),
    }).annotate(strictParseOptions),
    output: ReceivedInput,
  }),
  // The endpoint decodes the count to a number; the port takes its string.
  countNotes: query({
    input: Schema.Struct({ count: Schema.NumberFromString }).annotate(
      strictParseOptions
    ),
    output: ReceivedInput,
  }),
});
type NoteOperations = typeof noteOperations;

const noteErrors = [CliInputInvalid.schema] as const;

const NoteEndpoints = administrationOperationGroupCheckingDhwFirst(
  HttpApiGroup.make("notes").add(
    HttpApiEndpoint.get(
      ...bareRequest(noteOperations.listNotes, "/notes", noteErrors)
    ).pipe(servesOperation(noteOperations.listNotes)),
    HttpApiEndpoint.get(
      ...paramsRequest(
        noteOperations.getNote,
        "/notes/:noteId",
        ["noteId"],
        noteErrors
      )
    ).pipe(servesOperation(noteOperations.getNote)),
    HttpApiEndpoint.get(
      ...paramsQueryRequest(
        noteOperations.searchNotes,
        "/folders/:folderId/notes",
        ["folderId"],
        noteErrors
      )
    ).pipe(servesOperation(noteOperations.searchNotes)),
    HttpApiEndpoint.post(
      ...bodyRequest(noteOperations.createNote, "/notes", noteErrors)
    ).pipe(
      servesOperation(noteOperations.createNote, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.patch(
      ...paramsBodyRequest(
        noteOperations.editNote,
        "/notes/:noteId",
        ["noteId"],
        noteErrors
      )
    ).pipe(
      servesOperation(noteOperations.editNote, {
        behavior: writeOperation({ idempotent: false }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsRequest(
        noteOperations.archiveNote,
        "/notes/:noteId/archive",
        ["noteId"],
        noteErrors
      )
    ).pipe(
      servesOperation(noteOperations.archiveNote, {
        behavior: destructiveOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.patch(
      ...paramsBodyRequest(
        noteOperations.renameNote,
        "/notes/:noteId/title",
        ["noteId"],
        noteErrors
      )
    ).pipe(
      servesOperation(noteOperations.renameNote, {
        behavior: writeOperation({ idempotent: true }),
      })
    ),
    HttpApiEndpoint.post(
      ...paramsFieldRequest(
        noteOperations.previewNote,
        "/notes/:noteId/preview",
        ["noteId"],
        "draft",
        noteErrors
      )
    ).pipe(servesOperation(noteOperations.previewNote, { body: "draft" })),
    HttpApiEndpoint.get(
      ...queryRequest(noteOperations.countNotes, "/note-counts", noteErrors)
    ).pipe(servesOperation(noteOperations.countNotes))
  )
);

const notesServer: OperationGroupServer<
  typeof NoteEndpoints,
  NoteOperations
> = (api, invoker, outputs) =>
  HttpApiBuilder.group(api, "notes", (handlers) =>
    Effect.map(invoker, (invoke) => {
      const serve = operationHandler(
        NoteEndpoints,
        noteOperations,
        invoke,
        outputs
      );
      return handlers.handleAll({
        listNotes: serve("listNotes"),
        getNote: serve("getNote"),
        searchNotes: serve("searchNotes"),
        createNote: serve("createNote"),
        editNote: serve("editNote"),
        archiveNote: serve("archiveNote"),
        renameNote: serve("renameNote"),
        previewNote: serve("previewNote"),
        countNotes: serve("countNotes"),
      });
    })
  );

const Notes = operationGroup(NoteEndpoints, noteOperations, notesServer);

const inputs = {
  listNotes: {},
  getNote: { noteId: "note-1" },
  searchNotes: { folderId: "folder-1", text: "tea" },
  createNote: {
    requestId: "01990000-0000-7000-8000-000000000001",
    text: "Tea",
  },
  editNote: { noteId: "note-1", text: "Coffee" },
  archiveNote: { noteId: "note-1" },
  renameNote: { noteId: "note-1", title: "Tea notes" },
  previewNote: { noteId: "note-1", draft: { copyOf: "note-2" } },
  countNotes: { count: "3" },
} satisfies {
  readonly [Name in keyof NoteOperations]: OperationInput<NoteOperations[Name]>;
};
const names = Struct.keys(inputs);

const api = HttpApi.make("notesApi").add(Notes);

const echoInput = <Name extends keyof NoteOperations>(
  name: Name,
  input: OperationInput<NoteOperations[Name]>
) =>
  Schema.decodeUnknownEffect(noteOperations[name].output)(
    JSON.stringify(input)
  ).pipe(Effect.orDie);

/** The administration middleware a notes server runs its requests through. */
const administrationMiddleware = Layer.mergeAll(
  Layer.succeed(AdministrationAuthentication, {
    bearer: (httpEffect) =>
      Effect.provideService(httpEffect, CurrentAdministrationCaller, {
        actor: {
          accountId: AdministrationAccountId.make("account-1"),
          email: testEmailAddress("notes-administrator"),
        },
        channel: {
          _tag: "CliSession",
          sessionId: CliSessionId.make("01980000-0000-7000-8000-000000000000"),
        },
      }),
  }),
  Layer.succeed(AdministrationActionRecord, (httpEffect) => httpEffect),
  Layer.succeed(CliClientCompatibility, (httpEffect) => httpEffect)
);

const server = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(api).pipe(
    Layer.provide(
      operationGroupHandlers(api, Notes, Effect.succeed(echoInput), {
        listNotes: (received: string) => Effect.succeed(`adapted ${received}`),
      })
    ),
    Layer.provide(administrationMiddleware),
    Layer.provide(HttpServer.layerServices)
  ),
  { disableLogger: true }
);
afterAll(() => server.dispose());

/** An HTTP client sending each request to `handler`. */
const httpClientOf = (handler: (request: Request) => Promise<Response>) =>
  HttpClient.make((request) =>
    HttpClientRequest.toWeb(request).pipe(
      Effect.flatMap((webRequest) => Effect.promise(() => handler(webRequest))),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.orDie
    )
  );

const baseUrl = "https://workspace.deskohub.test";

const notesClient = HttpApiClient.make(api, { baseUrl }).pipe(
  Effect.map(({ notes }) => notes),
  Effect.provideService(HttpClient.HttpClient, httpClientOf(server.handler))
);

/** A client method, sent the request parts `operationRequest` builds. */
interface RequestSender {
  readonly send: (request: OperationRequest) => Effect.Effect<string, unknown>;
}

/**
 * Sends a request through `method` once it decodes to the parts `shape`
 * states, which are the parts the method takes.
 */
const sender = <Parts>(
  shape: Schema.Decoder<Parts>,
  method: (parts: Parts) => Effect.Effect<string, unknown>
): RequestSender => ({
  send: (request) =>
    Schema.decodeUnknownEffect(shape)(request).pipe(
      Effect.orDie,
      Effect.flatMap(method)
    ),
});

const NoteParams = Schema.Struct({ params: NoteRef });

/**
 * Each name's client method, sent the request parts `operationRequest` builds
 * for that name's route.
 */
const sendersOf = (
  client: Effect.Success<typeof notesClient>
): { readonly [Name in keyof NoteOperations]: RequestSender } => ({
  // listNotes takes no input, so its request carries no parts.
  listNotes: { send: () => client.listNotes() },
  getNote: sender(NoteParams, client.getNote),
  searchNotes: sender(
    Schema.Struct({
      params: Schema.Struct({ folderId: NoteId }),
      query: Schema.Struct({ text: Schema.optionalKey(Schema.String) }),
    }),
    client.searchNotes
  ),
  createNote: sender(
    Schema.Struct({ payload: noteOperations.createNote.input }),
    client.createNote
  ),
  editNote: sender(
    NoteParams.mapFields(
      Struct.assign({ payload: Schema.Struct({ text: Schema.String }) })
    ),
    client.editNote
  ),
  archiveNote: sender(NoteParams, client.archiveNote),
  renameNote: sender(
    NoteParams.mapFields(
      Struct.assign({
        payload: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
      })
    ),
    client.renameNote
  ),
  previewNote: sender(
    NoteParams.mapFields(
      Struct.assign({
        payload: noteOperations.previewNote.input.fields.draft,
      })
    ),
    client.previewNote
  ),
  countNotes: sender(
    Schema.Struct({ query: noteOperations.countNotes.input }),
    client.countNotes
  ),
});

/** What the client sends for `name`'s input, and what the operation receives. */
const call = <Name extends keyof NoteOperations>(
  name: Name,
  input: OperationInput<NoteOperations[Name]> = inputs[name]
) =>
  notesClient.pipe(
    Effect.flatMap((client) =>
      sendersOf(client)[name].send(operationRequest(Notes, name, input))
    ),
    Effect.runPromise
  );

describe("operation endpoints", () => {
  test("a client carries each input in the request parts its route names", () => {
    expect(
      Object.fromEntries(
        names.map((name) => [name, operationRequest(Notes, name, inputs[name])])
      )
    ).toEqual({
      listNotes: {},
      getNote: { params: { noteId: "note-1" } },
      searchNotes: { params: { folderId: "folder-1" }, query: { text: "tea" } },
      createNote: { payload: inputs.createNote },
      editNote: { params: { noteId: "note-1" }, payload: { text: "Coffee" } },
      archiveNote: { params: { noteId: "note-1" } },
      renameNote: {
        params: { noteId: "note-1" },
        payload: { title: "Tea notes" },
      },
      previewNote: {
        params: { noteId: "note-1" },
        payload: { copyOf: "note-2" },
      },
      countNotes: { query: { count: "3" } },
    });
  });

  test("each endpoint's request and success types are the operation's", () => {
    type Endpoint<Name extends string> = HttpApiEndpoint.WithIdentifier<
      HttpApiGroup.Endpoints<typeof Notes>,
      Name
    >;
    type Parts<Name extends string> = {
      readonly params: Endpoint<Name>["~Params"]["Type"];
      readonly query: Endpoint<Name>["~Query"]["Type"];
      readonly payload: Endpoint<Name>["~Payload"]["Type"];
      readonly success: Endpoint<Name>["~Success"]["Type"];
    };

    expectTypeOf<Parts<"listNotes">>().toEqualTypeOf<{
      readonly params: never;
      readonly query: never;
      readonly payload: never;
      readonly success: string;
    }>();
    expectTypeOf<Parts<"searchNotes">>().toEqualTypeOf<{
      readonly params: { readonly folderId: string };
      readonly query: { readonly text?: string };
      readonly payload: never;
      readonly success: string;
    }>();
    expectTypeOf<Parts<"createNote">>().toEqualTypeOf<{
      readonly params: never;
      readonly query: never;
      readonly payload: {
        readonly requestId: CliMutationRequestId;
        readonly text: string;
      };
      readonly success: string;
    }>();
    expectTypeOf<Parts<"editNote">>().toEqualTypeOf<{
      readonly params: { readonly noteId: string };
      readonly query: never;
      readonly payload: { readonly text: string };
      readonly success: string;
    }>();
    expectTypeOf<Parts<"archiveNote">>().toEqualTypeOf<{
      readonly params: { readonly noteId: string };
      readonly query: never;
      readonly payload: never;
      readonly success: string;
    }>();
    expectTypeOf<Parts<"previewNote">>().toEqualTypeOf<{
      readonly params: { readonly noteId: string };
      readonly query: never;
      readonly payload: { readonly text: string } | { readonly copyOf: string };
      readonly success: string;
    }>();
  });

  test.each(names.filter((name) => name !== "listNotes"))(
    "%s runs its operation on the input its request carries",
    async (name) => {
      expect(JSON.parse(await call(name))).toEqual(inputs[name]);
    }
  );

  test("a query or body whose fields are all optional is sent empty", async () => {
    const withoutText = { folderId: "folder-1" };
    const withoutTitle = { noteId: "note-1" };

    expect(operationRequest(Notes, "searchNotes", withoutText)).toEqual({
      params: withoutText,
      query: {},
    });
    expect(operationRequest(Notes, "renameNote", withoutTitle)).toEqual({
      params: withoutTitle,
      payload: {},
    });
    expect(JSON.parse(await call("searchNotes", withoutText))).toEqual(
      withoutText
    );
    expect(JSON.parse(await call("renameNote", withoutTitle))).toEqual(
      withoutTitle
    );
  });

  test("the operation receives a transformed field in its encoded form", async () => {
    expect(await call("countNotes", { count: "12" })).toBe('{"count":"12"}');
  });

  test("a sender refuses request parts its route doesn't take", async () => {
    const send = notesClient.pipe(
      Effect.flatMap((client) => sendersOf(client).getNote.send({})),
      Effect.runPromise
    );
    await expect(send).rejects.toThrow();
  });

  test("an output adapter answers in place of the operation's output", async () => {
    expect(await call("listNotes")).toBe("adapted {}");
  });

  test("a query is a read, and a mutation behaves as its route states", () => {
    expect(
      Object.fromEntries(
        administrationOperations(api).map(({ endpoint, access }) => [
          endpoint,
          access,
        ])
      )
    ).toEqual({
      listNotes: { _tag: "Operation", behavior: readOperation },
      getNote: { _tag: "Operation", behavior: readOperation },
      searchNotes: { _tag: "Operation", behavior: readOperation },
      createNote: {
        _tag: "Operation",
        behavior: { kind: "write", idempotent: true },
      },
      editNote: {
        _tag: "Operation",
        behavior: { kind: "write", idempotent: false },
      },
      archiveNote: {
        _tag: "Operation",
        behavior: { kind: "destructive", idempotent: true },
      },
      renameNote: {
        _tag: "Operation",
        behavior: { kind: "write", idempotent: true },
      },
      previewNote: { _tag: "Operation", behavior: readOperation },
      countNotes: { _tag: "Operation", behavior: readOperation },
    });
  });

  test("an endpoint requires its operation's minimum dhw", () => {
    const versioned = defineOperations({
      getNote: query({
        input: NoteRef,
        output: ReceivedInput,
        minimumDhwVersion: DhwVersion.make("1.2.3"),
      }),
    });
    const group = HttpApiGroup.make("versioned").add(
      HttpApiEndpoint.get(
        ...paramsRequest(versioned.getNote, "/notes/:noteId", ["noteId"], [])
      ).pipe(servesOperation(versioned.getNote))
    );
    const minimums: Array<unknown> = [];
    HttpApi.reflect(HttpApi.make("versionedApi").add(group), {
      onGroup: () => undefined,
      onEndpoint: ({ mergedAnnotations }) => {
        minimums.push(Context.get(mergedAnnotations, MinimumDhwVersion));
      },
    });

    expect(minimums).toEqual([Option.some("1.2.3")]);
  });

  test("a request that can't carry its operation's input fails the typecheck", () => {
    type GetNote = typeof noteOperations.getNote;
    type SearchNotes = typeof noteOperations.searchNotes;
    // A path without the keys' parameter takes no path.
    expectTypeOf("/notes" as const).not.toMatchTypeOf<
      Parameters<
        typeof paramsRequest<
          "getNote",
          GetNote["input"]["fields"],
          typeof ReceivedInput,
          "/notes",
          readonly ["noteId"],
          readonly []
        >
      >[1]
    >();
    // Input beyond the path parameters has no place in a params-only request.
    expectTypeOf(["folderId"] as const).not.toMatchTypeOf<
      Parameters<
        typeof paramsRequest<
          "searchNotes",
          SearchNotes["input"]["fields"],
          typeof ReceivedInput,
          "/folders/:folderId/notes",
          readonly ["folderId"],
          readonly []
        >
      >[2]
    >();
    // An input with fields isn't one a bare request carries.
    expectTypeOf(noteOperations.getNote).not.toMatchTypeOf<
      Parameters<
        typeof bareRequest<
          "getNote",
          typeof ReceivedInput,
          "/notes",
          readonly []
        >
      >[0]
    >();
  });

  test("an endpoint serves only the operation it is named after, as its kind allows", () => {
    // The endpoint `servesOperation` takes is named after its operation.
    type ServedName<Op extends Operation> = HttpApiEndpoint.Identifier<
      Parameters<ReturnType<typeof servesOperation<Op>>>[0]
    >;
    expectTypeOf<
      ServedName<typeof noteOperations.getNote>
    >().toEqualTypeOf<"getNote">();
    expectTypeOf<
      ServedName<typeof noteOperations.archiveNote>
    >().toEqualTypeOf<"archiveNote">();
    // A query is a read and declares no behavior.
    expectTypeOf({ behavior: readOperation }).not.toMatchTypeOf<
      ServedOperationOptions<typeof noteOperations.listNotes, never>
    >();
    // A mutation declares its behavior, and a replayed one is idempotent.
    expectTypeOf({}).not.toMatchTypeOf<
      ServedOperationOptions<typeof noteOperations.editNote, never>
    >();
    expectTypeOf({
      behavior: writeOperation({ idempotent: false }),
    }).not.toMatchTypeOf<
      ServedOperationOptions<typeof noteOperations.createNote, never>
    >();
    expectTypeOf({
      behavior: writeOperation({ idempotent: true }),
    }).toMatchTypeOf<
      ServedOperationOptions<typeof noteOperations.createNote, never>
    >();
  });

  test("a group's endpoints are its operations, each under its own name", () => {
    type Aliased = { readonly alias: typeof noteOperations.getNote };
    expectTypeOf<Aliased>().not.toMatchTypeOf<SelfNamedOperations<Aliased>>();
    expectTypeOf<NoteOperations>().toMatchTypeOf<
      SelfNamedOperations<NoteOperations>
    >();
    expectTypeOf<keyof typeof Notes.endpoints>().toEqualTypeOf<
      keyof NoteOperations
    >();
    expect(Object.keys(Notes.endpoints)).toEqual(Object.keys(noteOperations));

    const getNoteOnly = HttpApiGroup.make("getNoteOnly").add(
      HttpApiEndpoint.get(
        ...paramsRequest(
          noteOperations.getNote,
          "/notes/:noteId",
          ["noteId"],
          noteErrors
        )
      ).pipe(servesOperation(noteOperations.getNote))
    );
    const getNoteServer: OperationGroupServer<
      typeof getNoteOnly,
      NoteOperations
    > = (api, invoker, outputs) =>
      HttpApiBuilder.group(api, "getNoteOnly", (handlers) =>
        Effect.map(invoker, (invoke) =>
          handlers.handleAll({
            getNote: operationHandler(
              getNoteOnly,
              noteOperations,
              invoke,
              outputs
            )("getNote"),
          })
        )
      );
    expect(() =>
      operationGroup(getNoteOnly, noteOperations, getNoteServer)
    ).toThrow("getNoteOnly serves no endpoint for listNotes.");
    // A caller the types don't check can still alias an operation.
    expect(() =>
      Reflect.apply(operationGroup, undefined, [
        getNoteOnly,
        { getNote: noteOperations.listNotes },
        getNoteServer,
      ])
    ).toThrow("getNoteOnly.getNote names listNotes.");
  });

  test("a mutation's endpoint declares its behavior", () => {
    // A caller the types don't check can still leave the behavior out.
    const servesWithoutBehavior: unknown = Reflect.apply(
      servesOperation,
      undefined,
      [noteOperations.editNote]
    );
    if (!Predicate.isFunction(servesWithoutBehavior)) {
      throw new Error("servesOperation returns no function.");
    }
    const endpoint = HttpApiEndpoint.patch(
      ...paramsBodyRequest(
        noteOperations.editNote,
        "/notes/:noteId",
        ["noteId"],
        noteErrors
      )
    );
    expect(() =>
      Reflect.apply(servesWithoutBehavior, undefined, [endpoint])
    ).toThrow("editNote is a mutation without a behavior.");
  });

  test("a composed API serves a group under its identifier", async () => {
    const combined = HttpApi.make("combined").addHttpApi(api);
    const composed = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(combined).pipe(
        Layer.provide(
          operationGroupHandlers(combined, Notes, Effect.succeed(echoInput))
        ),
        Layer.provide(administrationMiddleware),
        Layer.provide(HttpServer.layerServices)
      ),
      { disableLogger: true }
    );
    try {
      const received = await HttpApiClient.make(combined, { baseUrl }).pipe(
        Effect.flatMap(({ notes }) =>
          sendersOf(notes).getNote.send(
            operationRequest(Notes, "getNote", inputs.getNote)
          )
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          httpClientOf(composed.handler)
        ),
        Effect.runPromise
      );
      expect(received).toBe(await call("getNote"));
    } finally {
      await composed.dispose();
    }
  });

  test("the helpers take their base type arguments explicitly", () => {
    expectTypeOf(
      operationRequest<NoteOperations, "getNote">(
        Notes,
        "getNote",
        inputs.getNote
      )
    ).toEqualTypeOf<OperationRequest>();
    expectTypeOf(
      operationGroupHandlers<
        "notesApi",
        typeof Notes,
        typeof Notes,
        never,
        never,
        never,
        never
      >(api, Notes, Effect.succeed(echoInput))
    ).toEqualTypeOf(
      operationGroupHandlers(api, Notes, Effect.succeed(echoInput))
    );
  });
});

/** Stamps an adapted output, as an output adapter's service may. */
class OutputStamp extends Context.Service<OutputStamp, string>()(
  "@deskohub/workspace-admin-api/test/OutputStamp"
) {}

/** Encodes a count with a service, as an input schema may. */
class CountEncoder extends Context.Service<CountEncoder, number>()(
  "@deskohub/workspace-admin-api/test/CountEncoder"
) {}

const tallyOperations = defineOperations({
  tally: query({
    input: Schema.Struct({
      count: Schema.NumberFromString.pipe(
        Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.passthrough<number>(),
          encode: SchemaGetter.transformEffect((count: number) =>
            Effect.gen(function* () {
              const offset = yield* CountEncoder;
              return count + offset;
            })
          ),
        })
      ),
    }).annotate(strictParseOptions),
    output: ReceivedInput,
  }),
});

const TallyEndpoints = administrationOperationGroupCheckingDhwFirst(
  HttpApiGroup.make("tallies").add(
    HttpApiEndpoint.get(
      ...queryRequest(tallyOperations.tally, "/tallies", noteErrors)
    ).pipe(servesOperation(tallyOperations.tally))
  )
);

const talliesServer: OperationGroupServer<
  typeof TallyEndpoints,
  typeof tallyOperations
> = (api, invoker, outputs) =>
  HttpApiBuilder.group(api, "tallies", (handlers) =>
    Effect.map(invoker, (invoke) =>
      handlers.handleAll({
        tally: operationHandler(
          TallyEndpoints,
          tallyOperations,
          invoke,
          outputs
        )("tally"),
      })
    )
  );

const Tallies = operationGroup(TallyEndpoints, tallyOperations, talliesServer);

describe("an operation whose input encodes with a service", () => {
  const tallyApi = HttpApi.make("talliesApi").add(Tallies);
  const tallyHandlers = operationGroupHandlers(
    tallyApi,
    Tallies,
    Effect.succeed((_name: "tally", input: { readonly count: string }) =>
      Effect.succeed(JSON.stringify(input))
    )
  );

  test("requires that service to be served", () => {
    type Requirements =
      typeof tallyHandlers extends Layer.Layer<
        infer _Provided,
        infer _Error,
        infer Required
      >
        ? Required
        : never;
    const required: HttpRouter.Request<
      "Requires",
      CountEncoder
    > extends Requirements
      ? true
      : false = true;
    expect(required).toBe(true);
  });

  test("requires the services its output adapters use", () => {
    const adapted = operationGroupHandlers(
      tallyApi,
      Tallies,
      Effect.succeed((_name: "tally", input: { readonly count: string }) =>
        Effect.succeed(JSON.stringify(input))
      ),
      {
        tally: (output: string) =>
          Effect.gen(function* () {
            return `${yield* OutputStamp} ${output}`;
          }),
      }
    );
    type Requirements =
      typeof adapted extends Layer.Layer<
        infer _Provided,
        infer _Error,
        infer Required
      >
        ? Required
        : never;
    const required: HttpRouter.Request<
      "Requires",
      OutputStamp
    > extends Requirements
      ? true
      : false = true;
    expect(required).toBe(true);
  });

  test("requires the services of an optional adapter its explicit outputs type declares", () => {
    type Adapters = {
      readonly tally?: (
        output: string
      ) => Effect.Effect<string, never, OutputStamp>;
    };
    const adapters: Adapters = {
      tally: (output) =>
        Effect.gen(function* () {
          return `${yield* OutputStamp} ${output}`;
        }),
    };
    const adapted = operationGroupHandlers<
      "talliesApi",
      typeof Tallies,
      typeof Tallies,
      never,
      never,
      never,
      never,
      Adapters
    >(
      tallyApi,
      Tallies,
      Effect.succeed((_name: "tally", input: { readonly count: string }) =>
        Effect.succeed(JSON.stringify(input))
      ),
      adapters
    );
    type Requirements =
      typeof adapted extends Layer.Layer<
        infer _Provided,
        infer _Error,
        infer Required
      >
        ? Required
        : never;
    const required: HttpRouter.Request<
      "Requires",
      OutputStamp
    > extends Requirements
      ? true
      : false = true;
    expect(required).toBe(true);
  });

  test("re-encodes the input with that service", async () => {
    const tallyServer = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(tallyApi).pipe(
        Layer.provide(tallyHandlers),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AdministrationAuthentication, {
              bearer: (httpEffect) =>
                Effect.provideService(httpEffect, CurrentAdministrationCaller, {
                  actor: {
                    accountId: AdministrationAccountId.make("account-1"),
                    email: testEmailAddress("tally-administrator"),
                  },
                  channel: {
                    _tag: "CliSession",
                    sessionId: CliSessionId.make(
                      "01980000-0000-7000-8000-000000000000"
                    ),
                  },
                }),
            }),
            Layer.succeed(
              AdministrationActionRecord,
              (httpEffect) => httpEffect
            ),
            Layer.succeed(CliClientCompatibility, (httpEffect) => httpEffect)
          )
        ),
        Layer.provide(HttpServer.layerServices)
      ),
      { disableLogger: true }
    );
    try {
      const response = await tallyServer.handler(
        new Request(
          "https://workspace.deskohub.test/api/v1/cli/tallies?count=3",
          {
            headers: { authorization: "Bearer session" },
          }
        ),
        Context.make(CountEncoder, 10)
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toBe(JSON.stringify({ count: "13" }));
    } finally {
      await tallyServer.dispose();
    }
  });
});

/** Marks requests, as middleware an API adds after binding a group may. */
class ReviewMarker extends HttpApiMiddleware.Service<ReviewMarker>()(
  "@deskohub/workspace-admin-api/test/ReviewMarker"
) {}

/** Notes an API composed into another, as an annotation `addHttpApi` carries. */
class ComposedNote extends Context.Service<ComposedNote, string>()(
  "@deskohub/workspace-admin-api/test/ComposedNote"
) {}

describe("the API serving one group", () => {
  test("is one serving the group with its own codecs", () => {
    const otherTallyOperations = defineOperations({
      tally: query({
        input: tallyOperations.tally.input,
        output: Schema.Boolean,
      }),
    });
    const OtherTallies = administrationOperationGroupCheckingDhwFirst(
      HttpApiGroup.make("tallies").add(
        HttpApiEndpoint.get(
          ...queryRequest(otherTallyOperations.tally, "/tallies", noteErrors)
        ).pipe(servesOperation(otherTallyOperations.tally))
      )
    );
    type GroupsOf<Api> =
      Api extends HttpApi.HttpApi<"talliesApi", infer Groups> ? Groups : never;
    type ServingTallies<Api> = Parameters<
      typeof operationGroupHandlers<
        "talliesApi",
        GroupsOf<Api>,
        typeof Tallies,
        never,
        never,
        never,
        never
      >
    >[0];
    const serving = HttpApi.make("talliesApi").add(Tallies);
    expectTypeOf(serving).toMatchTypeOf<ServingTallies<typeof serving>>();
    const otherCodecs = HttpApi.make("talliesApi").add(OtherTallies);
    expectTypeOf(otherCodecs).not.toMatchTypeOf<
      ServingTallies<typeof otherCodecs>
    >();
    const twice = HttpApi.make("talliesApi").add(Tallies).add(OtherTallies);
    expectTypeOf(twice).not.toMatchTypeOf<ServingTallies<typeof twice>>();
    const empty = HttpApi.make("talliesApi");
    expectTypeOf(empty).not.toMatchTypeOf<ServingTallies<typeof empty>>();
    const unauthenticated = HttpApi.make("talliesApi").add(
      HttpApiGroup.make("tallies")
        .add(
          HttpApiEndpoint.get(
            ...queryRequest(tallyOperations.tally, "/tallies", noteErrors)
          ).pipe(servesOperation(tallyOperations.tally))
        )
        .prefix("/api/v1/cli")
    );
    expectTypeOf(unauthenticated).not.toMatchTypeOf<
      ServingTallies<typeof unauthenticated>
    >();
  });

  test("refuses a group with its types but other codecs", () => {
    const redeclared = HttpApi.make("talliesApi").add(
      administrationOperationGroupCheckingDhwFirst(
        HttpApiGroup.make("tallies").add(
          HttpApiEndpoint.get(
            ...queryRequest(tallyOperations.tally, "/tallies", noteErrors)
          ).pipe(servesOperation(tallyOperations.tally))
        )
      )
    );
    expect(() =>
      operationGroupHandlers(
        redeclared,
        Tallies,
        Effect.succeed((_name: "tally", input: { readonly count: string }) =>
          Effect.succeed(JSON.stringify(input))
        )
      )
    ).toThrow(
      "talliesApi serves tallies with other codecs or without its middleware."
    );
  });
});

describe("an API that transforms a group after binding it", () => {
  /** A `getNote` request for note-1 under `prefix`. */
  const getNoteAt = (prefix = "") =>
    new Request(`${baseUrl}${prefix}/api/v1/cli/notes/note-1`, {
      headers: { authorization: "Bearer session" },
    });

  /** The response `served` gives `request`, disposing of `served` after. */
  const respond = async (
    served: {
      readonly handler: (
        request: Request,
        context: Context.Context<never>
      ) => Promise<Response>;
      readonly dispose: () => Promise<void>;
    },
    request: Request
  ) => {
    try {
      const response = await served.handler(request, Context.empty());
      return { status: response.status, body: await response.text() };
    } finally {
      await served.dispose();
    }
  };

  /** The response the API that binds `Notes` gives a `getNote` request. */
  const expected = async () => {
    const response = await server.handler(getNoteAt());
    expect(response.status).toBe(200);
    return { status: response.status, body: await response.text() };
  };

  test("serves it with authentication middleware applied again", async () => {
    const authenticated = api.middleware(AdministrationAuthentication);
    const served = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(authenticated).pipe(
        Layer.provide(
          operationGroupHandlers(
            authenticated,
            Notes,
            Effect.succeed(echoInput)
          )
        ),
        Layer.provide(administrationMiddleware),
        Layer.provide(HttpServer.layerServices)
      ),
      { disableLogger: true }
    );
    expect(await respond(served, getNoteAt())).toEqual(await expected());
  });

  /** What `ReviewMarker` saw of a request. */
  type Seen = readonly [
    endpoint: string,
    endpointNote: Option.Option<string>,
    groupNote: Option.Option<string>,
  ];

  /** The endpoints `ReviewMarker` saw, with their and their group's `ComposedNote`. */
  const markerLayer = (seen: Array<Seen>) =>
    Layer.succeed(ReviewMarker, (httpEffect, { endpoint, group }) =>
      Effect.andThen(
        Effect.sync(() => {
          seen.push([
            endpoint.identifier,
            Context.getOption(endpoint.annotations, ComposedNote),
            Context.getOption(group.annotations, ComposedNote),
          ]);
        }),
        httpEffect
      )
    );

  test("requires and runs middleware the API adds after binding it", async () => {
    const marked = api.middleware(ReviewMarker);
    const handlers = operationGroupHandlers(
      marked,
      Notes,
      Effect.succeed(echoInput)
    );
    expectTypeOf<ReviewMarker>().toMatchTypeOf<
      Layer.Services<typeof handlers>
    >();
    const plain = operationGroupHandlers(api, Notes, Effect.succeed(echoInput));
    expectTypeOf<ReviewMarker>().not.toMatchTypeOf<
      Layer.Services<typeof plain>
    >();
    const unmarked = HttpApiBuilder.layer(marked).pipe(
      Layer.provide(handlers),
      Layer.provide(administrationMiddleware),
      Layer.provide(HttpServer.layerServices)
    );
    expectTypeOf<ReviewMarker>().toMatchTypeOf<
      Layer.Services<typeof unmarked>
    >();
    const seen: Array<Seen> = [];
    const served = HttpRouter.toWebHandler(
      unmarked.pipe(Layer.provide(markerLayer(seen))),
      { disableLogger: true }
    );
    expect(await respond(served, getNoteAt())).toEqual(await expected());
    expect(seen).toEqual([["getNote", Option.none(), Option.none()]]);
  });

  test("serves it with its endpoints annotated", async () => {
    const annotated = HttpApi.make("annotated")
      .add(Notes.annotateEndpointsMerge(Context.make(ComposedNote, "endpoint")))
      .middleware(ReviewMarker);
    const seen: Array<Seen> = [];
    const served = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(annotated).pipe(
        Layer.provide(
          operationGroupHandlers(annotated, Notes, Effect.succeed(echoInput))
        ),
        Layer.provide(administrationMiddleware),
        Layer.provide(markerLayer(seen)),
        Layer.provide(HttpServer.layerServices)
      ),
      { disableLogger: true }
    );
    expect(await respond(served, getNoteAt())).toEqual(await expected());
    expect(seen).toEqual([["getNote", Option.some("endpoint"), Option.none()]]);
  });

  test("serves it with the annotations an API composed with addHttpApi carries", async () => {
    const composed = HttpApi.make("outerApi")
      .addHttpApi(api.annotate(ComposedNote, "inner"))
      .middleware(ReviewMarker);
    const seen: Array<Seen> = [];
    const served = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(composed).pipe(
        Layer.provide(
          operationGroupHandlers(composed, Notes, Effect.succeed(echoInput))
        ),
        Layer.provide(administrationMiddleware),
        Layer.provide(markerLayer(seen)),
        Layer.provide(HttpServer.layerServices)
      ),
      { disableLogger: true }
    );
    expect(await respond(served, getNoteAt())).toEqual(await expected());
    expect(seen).toEqual([["getNote", Option.none(), Option.some("inner")]]);
  });

  test("serves it at a prefix that names a path parameter", () => {
    const tenanted = HttpApi.make("tenanted")
      .addHttpApi(api)
      .prefix("/tenants/:tenantId");
    expect(
      Layer.isLayer(
        operationGroupHandlers(tenanted, Notes, Effect.succeed(echoInput))
      )
    ).toBe(true);
  });

  test("serves it beside a group whose type is generic", async () => {
    /** `other` with `Notes` added, and the layer serving `Notes` in it. */
    const withNotes = <
      Id extends string,
      Other extends HttpApiGroup.Constraint & { readonly identifier: "other" },
    >(
      other: HttpApi.HttpApi<Id, Other>
    ) => {
      const notesApi = other.add(Notes);
      return {
        notesApi,
        notes: operationGroupHandlers(
          notesApi,
          Notes,
          Effect.succeed(echoInput)
        ),
      };
    };
    const { notesApi, notes } = withNotes(
      HttpApi.make("withOther").add(HttpApiGroup.make("other"))
    );
    const serve = () =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(notesApi).pipe(
          Layer.provide(notes),
          Layer.provide(
            HttpApiBuilder.group(notesApi, "other", (handlers) => handlers)
          ),
          Layer.provide(administrationMiddleware),
          Layer.provide(HttpServer.layerServices)
        ),
        { disableLogger: true }
      );
    expect(await respond(serve(), getNoteAt())).toEqual(await expected());
  });

  test("serves whichever of its groups a caller chooses", () => {
    const both = HttpApi.make("both").add(Notes, Tallies);
    /** The layer serving the group `useNotes` chooses. */
    const serving = (useNotes: boolean) =>
      operationGroupHandlers(
        both,
        useNotes ? Notes : Tallies,
        Effect.succeed(() => Effect.die("unused"))
      );
    expect(Layer.isLayer(serving(true))).toBe(true);
    expect(Layer.isLayer(serving(false))).toBe(true);
  });

  test("serves it at the prefix a composed API adds", async () => {
    const prefixed = HttpApi.make("prefixed").addHttpApi(api).prefix("/v2");
    const path: "/v2/api/v1/cli/notes/:noteId" =
      prefixed.groups.notes.endpoints.getNote.path;
    expect(path).toBe("/v2/api/v1/cli/notes/:noteId");
    const serve = () =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(prefixed).pipe(
          Layer.provide(
            operationGroupHandlers(prefixed, Notes, Effect.succeed(echoInput))
          ),
          Layer.provide(administrationMiddleware),
          Layer.provide(HttpServer.layerServices)
        ),
        { disableLogger: true }
      );
    expect(await respond(serve(), getNoteAt("/v2"))).toEqual(await expected());
    expect((await respond(serve(), getNoteAt())).status).toBe(404);
  });
});
