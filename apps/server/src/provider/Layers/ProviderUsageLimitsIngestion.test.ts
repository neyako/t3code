import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderUsageLimitsUpdate,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layerTest, ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageLimitsIngestionLive } from "./ProviderUsageLimitsIngestion.ts";

const workId = ProviderInstanceId.make("codex_work");
const personalId = ProviderInstanceId.make("codex_personal");
const limited = {
  type: "runtime.error",
  eventId: EventId.make("event-rate-limit"),
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: workId,
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-09-04T00:00:00.000Z",
  payload: { message: "Usage limit reached", class: "rate_limit" },
} satisfies ProviderRuntimeEvent;

const settingsLayer = () =>
  layerTest({
    providerInstances: {
      [workId]: {
        driver: "codex",
        enabled: true,
        displayName: "Work",
        config: { homePath: "/work" },
      },
      [personalId]: { driver: "codex", enabled: true, config: { homePath: "/personal" } },
    },
  });

const ingest = Effect.fn("test.ingestUsageLimits")(function* (
  events: ReadonlyArray<ProviderRuntimeEvent>,
  applyUsageLimits: (update: ProviderUsageLimitsUpdate) => Effect.Effect<void> = () => Effect.void,
) {
  const drained = yield* Deferred.make<void>();
  const instance = {
    snapshot: {
      applyUsageLimits,
      refresh: Effect.die("Quota probing must not delay disabling an exhausted account"),
    },
  } as unknown as ProviderInstance;
  yield* Layer.build(
    ProviderUsageLimitsIngestionLive.pipe(
      Layer.provide(
        Layer.succeed(ProviderInstanceRegistry, {
          getInstance: () => Effect.succeed(instance),
        } as unknown as ProviderInstanceRegistry["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderService, {
          streamEvents: Stream.concat(
            Stream.fromIterable(events),
            Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain),
          ),
        } as ProviderService["Service"]),
      ),
    ),
  );
  yield* Deferred.await(drained);
});

it.effect(
  "disables only the exhausted account through settings; the existing switch restores it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const before = yield* settings.getSettings;
        yield* ingest([limited, limited]);
        const after = yield* settings.getSettings;
        assert.deepEqual(after.providerInstances, {
          ...before.providerInstances,
          [workId]: { ...before.providerInstances[workId], enabled: false },
        });
        assert.deepEqual(after.providers, before.providers);

        yield* settings.updateSettings({
          providerInstances: {
            ...after.providerInstances,
            [workId]: { ...after.providerInstances[workId]!, enabled: true },
          },
        });
        assert.isTrue((yield* settings.getSettings).providerInstances[workId]?.enabled);
      }),
    ).pipe(Effect.provide(settingsLayer())),
);

it.effect("uses the legacy Codex toggle when the default instance has no explicit config", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const before = yield* settings.getSettings;
      yield* ingest([{ ...limited, providerInstanceId: ProviderInstanceId.make("codex") }]);
      const after = yield* settings.getSettings;
      assert.isFalse(after.providers.codex.enabled);
      assert.deepEqual(after.providerInstances, before.providerInstances);
    }),
  ).pipe(Effect.provide(settingsLayer())),
);

it.effect("ignores other errors and never recreates a removed account", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const before = yield* settings.getSettings;
      yield* ingest([
        { ...limited, payload: { ...limited.payload, class: "provider_error" } },
        { ...limited, provider: ProviderDriverKind.make("claudeAgent") },
        { ...limited, providerInstanceId: ProviderInstanceId.make("removed_account") },
      ]);
      assert.deepEqual(yield* settings.getSettings, before);
    }),
  ).pipe(Effect.provide(settingsLayer())),
);

it.effect("forwards quota telemetry without re-enabling a disabled account", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* ingest([limited]);
      const update = {
        windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 0 }],
      } satisfies ProviderUsageLimitsUpdate;
      const received: ProviderUsageLimitsUpdate[] = [];
      yield* ingest(
        [
          {
            ...limited,
            type: "account.rate-limits.updated",
            payload: { limits: update },
          },
        ],
        (limits) =>
          Effect.sync(() => {
            received.push(limits);
          }),
      );
      assert.lengthOf(received, 1);
      assert.deepEqual(received[0]?.windows, update.windows);
      assert.isFalse((yield* settings.getSettings).providerInstances[workId]?.enabled);
    }),
  ).pipe(Effect.provide(settingsLayer())),
);
