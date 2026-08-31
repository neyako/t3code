// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";
const decodePiSettings = Schema.decodeSync(PiSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockPiAcpWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-pi-acp.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readRequestLog(path: string): Promise<Array<{ method?: string; params?: unknown }>> {
  const text = await NodeFSP.readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
}

const piAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makePiAdapter>[1]) =>
  makePiAdapter(decodePiSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(piAdapterTestLayer)("PiAdapterLive", (it) => {
  it.effect("maps ACP usage updates to thread token usage events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-usage-update");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiAcpWrapper({ T3_ACP_EMIT_USAGE_UPDATE: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const usageEvent =
        yield* Deferred.make<
          Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>
        >();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "thread.token-usage.updated"
          ? Deferred.succeed(usageEvent, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "report usage", attachments: [] });

      const event = yield* Deferred.await(usageEvent);
      assert.deepStrictEqual(event.payload.usage, {
        usedTokens: 123,
        maxTokens: 1_024,
      });
      assert.equal(event.threadId, threadId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiAcpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "piAgent");
      assert.equal(session.providerInstanceId, ProviderInstanceId.make("piAgent"));
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello pi",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      const completed = runtimeEvents.find((e) => e.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }

      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("sends /compact as a Pi ACP prompt command", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-compact-command");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-compact-test-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiAcpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "/compact",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("piAgent"),
          model: "pi-default",
        },
      });

      const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
      const prompt = requests.find((request) => request.method === "session/prompt");
      assert.isFalse(requests.some((request) => request.method === "session/set_config_option"));
      assert.deepStrictEqual(prompt?.params, {
        sessionId: "mock-session-1",
        prompt: [{ type: "text", text: "/compact" }],
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails a Pi turn that stalls without ACP progress", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-watchdog-silent-turn");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiAcpWrapper({ T3_ACP_HANG_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const turnStarted = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started") {
            yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang forever", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnStarted);

      yield* TestClock.adjust("1 second");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );

      assert.equal(completed.payload.state, "failed");
      assert.equal(
        completed.payload.errorMessage,
        "Pi ACP turn stalled without progress for 1000ms.",
      );
      assert.equal(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)?.status,
        "ready",
      );

      yield* Fiber.interrupt(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces a Pi end_turn with no assistant response", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-empty-response");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiAcpWrapper({ T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        String(event.threadId) === String(threadId) && event.type === "turn.completed"
          ? Deferred.succeed(turnCompleted, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "return nothing", attachments: [] });

      const completed = yield* Deferred.await(turnCompleted);
      assert.equal(completed.payload.state, "failed");
      assert.equal(completed.payload.errorMessage, "Model returned no response");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
