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
            // Use the existing settings switch so installed clients and server
            // routing agree. Re-enabling stays an explicit user action.
            const instanceId = event.providerInstanceId;
            yield* serverSettings.updateSettings((settings) => {
              const config = settings.providerInstances[instanceId];
              if (config) {
                if (config.driver !== "codex" || config.enabled === false) return;
                return {
                  providerInstances: {
                    ...settings.providerInstances,
                    [instanceId]: { ...config, enabled: false },
                  },
                };
              }
              // Default instances may still use the legacy settings slot.
              if (instanceId === "codex" && settings.providers.codex.enabled) {
                return { providers: { codex: { enabled: false } } };
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
