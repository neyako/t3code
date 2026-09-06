/**
 * ProviderUsageLimitsIngestionLive — keeps owning-instance usage snapshots
 * current from runtime telemetry.
 *
 * Adapters normalise their native payloads before emitting, so this layer
 * never sees a driver shape: it routes the typed update to the instance and
 * lets `ServerProviderShape.applyUsageLimits` merge and republish on the
 * instance's own change stream, which `ProviderRegistry` already aggregates.
 *
 * @module provider/Layers/ProviderUsageLimitsIngestion
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";

export const ProviderUsageLimitsIngestionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const serverSettings = yield* ServerSettingsService;

    const restoreDueAccounts = Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* serverSettings.updateSettings((settings) => {
        const due = Object.entries(settings.providerAutoEnableAt).filter(
          ([, at]) => DateTime.toEpochMillis(DateTime.makeUnsafe(at)) <= now,
        );
        if (due.length === 0) return;
        const providerInstances = { ...settings.providerInstances };
        const providerAutoEnableAt = { ...settings.providerAutoEnableAt };
        let restoreLegacy = false;
        for (const [rawId] of due) {
          const id = ProviderInstanceId.make(rawId);
          delete providerAutoEnableAt[id];
          const config = providerInstances[id];
          if (config?.driver === "codex" && config.enabled === false) {
            providerInstances[id] = { ...config, enabled: true };
          } else if (id === "codex" && !config && !settings.providers.codex.enabled) {
            restoreLegacy = true;
          }
        }
        return {
          providerInstances,
          providerAutoEnableAt,
          ...(restoreLegacy ? { providers: { codex: { enabled: true } } } : {}),
        };
      });
    }).pipe(Effect.ignoreCause({ log: true }));

    // Persisted deadlines also recover accounts when the server was down at reset.
    yield* restoreDueAccounts;
    yield* restoreDueAccounts.pipe(Effect.delay("1 minute"), Effect.forever, Effect.forkScoped);

    yield* providerService.streamEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "account.rate-limits.updated" ||
          (event.provider === "codex" &&
            event.type === "runtime.error" &&
            event.payload.class === "rate_limit"),
      ),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (!event.providerInstanceId) {
            return;
          }
          const instance = yield* instanceRegistry.getInstance(event.providerInstanceId);
          if (!instance) {
            return;
          }
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          if (event.type === "account.rate-limits.updated") {
            yield* instance.snapshot.applyUsageLimits({ ...event.payload.limits, checkedAt });
          } else {
            // Read cached telemetry before disabling tears down the owning instance.
            const snapshot = yield* instance.snapshot.getSnapshot;
            const exhausted =
              snapshot.usageLimits?.windows.filter((window) => window.usedPercent >= 100) ?? [];
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const resets = exhausted.map((window) =>
              window.resetsAt === undefined
                ? NaN
                : DateTime.toEpochMillis(DateTime.makeUnsafe(window.resetsAt)),
            );
            const autoEnableAt =
              !snapshot.usageLimits?.unavailable &&
              resets.length > 0 &&
              resets.every((at) => at > now)
                ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets)))
                : undefined;
            const instanceId = event.providerInstanceId;
            yield* serverSettings.updateSettings((settings) => {
              const providerAutoEnableAt = { ...settings.providerAutoEnableAt };
              delete providerAutoEnableAt[instanceId];
              if (autoEnableAt !== undefined) providerAutoEnableAt[instanceId] = autoEnableAt;
              const config = settings.providerInstances[instanceId];
              if (config) {
                if (config.driver !== "codex" || config.enabled === false) return;
                return {
                  providerAutoEnableAt,
                  providerInstances: {
                    ...settings.providerInstances,
                    [instanceId]: { ...config, enabled: false },
                  },
                };
              }
              // Default instances may still use the legacy settings slot.
              if (instanceId === "codex" && settings.providers.codex.enabled) {
                return { providers: { codex: { enabled: false } }, providerAutoEnableAt };
              }
            });
          }
          // One bad event must not end the subscriber for every later one.
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);
