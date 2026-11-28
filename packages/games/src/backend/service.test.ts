import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { GamesService } from "./service";

describe("GamesService", () => {
  test("loads and validates the documented games response", async () => {
    const requests: Request[] = [];
    const fetchHandler = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request.clone());

      return Response.json({
        games: [
          {
            id: 1,
            bggId: 13,
            name: "Catan",
            yearPublished: 1995,
            imageUrl: "https://images.example.test/game.jpg",
            thumbnailUrl: "https://images.example.test/game-small.jpg",
            description: "A complete game",
            minPlayers: 3,
            maxPlayers: 4,
            playingTimeMinutes: 120,
            minAge: 10,
            weight: 2.31,
            rating: 7.4,
            categories: ["Economic"],
            mechanics: ["Dice Rolling"],
            inStock: true,
            note: null,
            language: "cz",
            addedAt: "2026-08-20T14:32:00.000Z",
            updatedAt: "2026-08-28T09:10:00.000Z",
          },
          {
            id: 2,
            bggId: 173346,
            name: "Darwin&#039;s &amp; &quot;Journey&quot; &#x1F3B2;",
            yearPublished: null,
            imageUrl: null,
            thumbnailUrl: null,
            description: null,
            minPlayers: null,
            maxPlayers: null,
            playingTimeMinutes: null,
            minAge: null,
            weight: null,
            rating: null,
            categories: null,
            mechanics: null,
            inStock: true,
            note: null,
            language: null,
            addedAt: "2026-08-30T11:45:06.698Z",
            updatedAt: "2026-08-30T11:45:06.698Z",
          },
          {
            id: 3,
            bggId: 224517,
            name: "Brass: Birmingham",
            inStock: true,
            addedAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
        ],
      });
    };

    const games = await Effect.gen(function* () {
      const service = yield* GamesService;
      return yield* service.listGames;
    }).pipe(
      Effect.provide(
        GamesService.Default.pipe(Layer.provide(fetchLayer(fetchHandler)))
      ),
      Effect.runPromise
    );

    expect(games).toHaveLength(3);
    expect(games.map((game) => game.name)).toEqual([
      "Catan",
      'Darwin\'s & "Journey" 🎲',
      "Brass: Birmingham",
    ]);
    expect(games[1]?.yearPublished).toBeNull();
    expect(games[1]?.imageUrl).toBeNull();
    expect(games[1]?.thumbnailUrl).toBeNull();
    expect(games[1]?.minPlayers).toBeNull();
    expect(games[1]?.maxPlayers).toBeNull();
    expect(games[1]?.playingTimeMinutes).toBeNull();
    expect(games[1]?.categories).toBeNull();
    expect(games[2]).not.toHaveProperty("playingTimeMinutes");
    expect(requests.map((request) => request.url)).toEqual([
      "https://deskohub-games.vercel.app/api/games",
    ]);
  });

  test("retries a transient catalog failure", async () => {
    let requestCount = 0;
    const fetchHandler = async () => {
      requestCount += 1;
      return requestCount === 1
        ? new Response("unavailable", { status: 503 })
        : Response.json({ games: [] });
    };

    const games = await Effect.gen(function* () {
      const service = yield* GamesService;
      return yield* service.listGames;
    }).pipe(
      Effect.provide(
        GamesService.Default.pipe(Layer.provide(fetchLayer(fetchHandler)))
      ),
      Effect.runPromise
    );

    expect(games).toEqual([]);
    expect(requestCount).toBe(2);
  });

  test("fails a stalled catalog request", async () => {
    const fetchHandler = () => new Promise<Response>(() => {});

    const failure = await Effect.gen(function* () {
      const service = yield* GamesService;
      const fiber = yield* service.listGames.pipe(
        Effect.flip,
        Effect.forkChild
      );
      yield* TestClock.adjust("10 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          GamesService.Default.pipe(Layer.provide(fetchLayer(fetchHandler))),
          TestClock.layer()
        )
      ),
      Effect.runPromise
    );

    expect(failure).toMatchObject({
      _tag: "GamesRequestError",
      message: "The board-game catalog request timed out.",
    });
  });
});

const fetchLayer = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        Object.assign(handler, { preconnect: globalThis.fetch.preconnect })
      )
    )
  );
