import { type PiSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const PI_DRIVER_KIND = ProviderDriverKind.make("piAgent");
// pi speaks its own RPC protocol; the community `pi-acp` adapter bridges it to
// ACP. T3 spawns the adapter, which in turn spawns `pi --mode rpc`. Auth is a
// no-op in the adapter — it relies on `pi` being logged in already.
export const PI_ACP_AUTH_METHOD_ID = "pi_terminal_login";

type PiAcpRuntimePiSettings = Pick<PiSettings, "binaryPath">;

interface PiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly piSettings: PiAcpRuntimePiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export function buildPiAcpSpawnInput(
  piSettings: PiAcpRuntimePiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  _runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: piSettings?.binaryPath || "pi-acp",
    args: [],
    cwd,
    env: { ...(environment ?? {}) },
  };
}

export const makePiAcpRuntime = (
  input: PiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPiAcpSpawnInput(
          input.piSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: PI_ACP_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolvePiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "pi-default";
  return normalizeModelSlug(base, PI_DRIVER_KIND) ?? "pi-default";
}

export interface PiModelConfigOption {
  readonly configId: string;
  readonly currentValue: string | undefined;
  readonly availableModels: ReadonlyArray<{ readonly value: string; readonly name: string }>;
}

/**
 * Pi exposes its model catalog as an ACP `select` config option (typically
 * id "model") instead of the `models` session state used by Grok. This reads
 * that option out of the raw config options of a session setup result.
 */
export function piModelConfigOptionFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): PiModelConfigOption | undefined {
  const option = configOptions?.find(
    (entry) => entry.type === "select" && entry.category === "model",
  );
  if (!option || option.type !== "select") {
    return undefined;
  }
  const currentValue =
    typeof option.currentValue === "string" && option.currentValue.trim().length > 0
      ? option.currentValue.trim()
      : undefined;
  const flatOptions = option.options.flatMap((entry) =>
    "group" in entry ? entry.options : [entry],
  );
  const options = flatOptions.filter(
    (entry) => typeof entry.value === "string" && entry.value.trim().length > 0,
  );
  return {
    configId: option.id,
    currentValue,
    availableModels: options.map((entry) => ({
      value: entry.value,
      name: entry.name ?? entry.value,
    })),
  };
}

/**
 * Selects the model through the model config option. Returns the resolved
 * model id so callers can keep the session display in sync.
 */
export function applyPiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requested = input.requestedModelId?.trim();
  if (!requested || requested === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime.setModel(requested).pipe(
    Effect.mapError(input.mapError),
    Effect.as(requested),
  );
}
