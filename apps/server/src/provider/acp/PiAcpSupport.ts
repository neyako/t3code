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
    env: { ...environment },
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

export interface PiThoughtLevelConfigOption {
  readonly configId: string;
  readonly currentValue: string | undefined;
  readonly availableLevels: ReadonlyArray<{ readonly value: string; readonly name: string }>;
}

/**
 * Pi exposes thinking levels as an ACP select config option (category
 * `thought_level`) and mirrors them in the session `modes` state.
 */
export function piThoughtLevelConfigOptionFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): PiThoughtLevelConfigOption | undefined {
  const option = configOptions?.find(
    (entry) => entry.type === "select" && entry.category === "thought_level",
  );
  if (!option || option.type !== "select") {
    return undefined;
  }
  const currentValue =
    typeof option.currentValue === "string" && option.currentValue.trim().length > 0
      ? option.currentValue.trim()
      : undefined;
  const options = option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
  return {
    configId: option.id,
    currentValue,
    availableLevels: options
      .filter((entry) => typeof entry.value === "string" && entry.value.trim().length > 0)
      .map((entry) => ({ value: entry.value, name: entry.name ?? entry.value })),
  };
}

/**
 * Reasoning options for the T3 model picker, derived from pi's thinking
 * levels. Uses the shared `reasoningEffort` option id so clients render the
 * standard Reasoning row.
 */
export function piReasoningOptionsFromThoughtLevels(input: {
  readonly availableLevels: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly currentValue: string | undefined;
}): {
  readonly options: ReadonlyArray<{
    value: string;
    label: string;
    isDefault?: boolean;
  }>;
  readonly currentValue: string | undefined;
} {
  if (input.availableLevels.length === 0) {
    return { options: [], currentValue: undefined };
  }
  const options = input.availableLevels.map((level) => ({
    value: level.value,
    label: level.name,
    ...(level.value === input.currentValue ? { isDefault: true } : {}),
  }));
  return { options, currentValue: input.currentValue };
}

/** Canonical pi thinking levels, in escalation order. */
const PI_THINKING_LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevelsByModel = ReadonlyMap<string, ReadonlyArray<string>>;

export interface PiCatalogModelEntry {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevelMap?: Record<string, string | null> | undefined;
}

/**
 * pi's ACP surface advertises one generic thinking-level list, but the
 * `thinkingLevelMap` in pi's own catalog (`~/.pi/agent/models-store.json`,
 * overridden by `models.json`) says which levels each model actually maps to
 * — GLM for example only supports low/high/max. Build a
 * `"provider/model" -> wire levels` index from those catalog entries so the
 * probe can scope the Reasoning row per model.
 */
export function piThinkingLevelsFromCatalogEntries(
  entries: ReadonlyArray<PiCatalogModelEntry>,
): PiThinkingLevelsByModel {
  const byModel = new Map<string, ReadonlyArray<string>>();
  for (const entry of entries) {
    const map = entry.thinkingLevelMap;
    if (!map) {
      continue;
    }
    const levels = PI_THINKING_LEVEL_ORDER.filter((level) => {
      const mapped = map[level];
      return typeof mapped === "string" && mapped.length > 0;
    }).map((level) => map[level] as string);
    if (levels.length > 0) {
      byModel.set(`${entry.provider}/${entry.id}`, levels);
    }
  }
  return byModel;
}

/** Resolves the supported reasoning levels for an ACP model value like `zai/glm-5.3`. */
export function piSupportedReasoningLevels(
  thinkingLevelsByModel: PiThinkingLevelsByModel,
  modelValue: string,
): ReadonlyArray<string> | undefined {
  return thinkingLevelsByModel.get(modelValue);
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
  return input.runtime
    .setModel(requested)
    .pipe(Effect.mapError(input.mapError), Effect.as(requested));
}

/**
 * Selects the thinking level through the `thought_level` config option. No-op
 * when the harness does not advertise one or nothing was requested.
 */
export function applyPiAcpReasoningSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly thoughtLevelConfigId: string | undefined;
  readonly currentReasoning: string | undefined;
  readonly requestedReasoning: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requested = input.requestedReasoning?.trim();
  if (!input.thoughtLevelConfigId || !requested || requested === input.currentReasoning) {
    return Effect.succeed(input.currentReasoning);
  }
  return input.runtime
    .setConfigOption(input.thoughtLevelConfigId, requested)
    .pipe(Effect.mapError(input.mapError), Effect.as(requested));
}
