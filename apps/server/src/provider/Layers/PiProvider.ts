// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as NodeFS from "node:fs";

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  makePiAcpRuntime,
  piModelConfigOptionFromConfigOptions,
  piReasoningOptionsFromThoughtLevels,
  piSupportedReasoningLevels,
  piThinkingLevelsFromCatalogEntries,
  piThoughtLevelConfigOptionFromConfigOptions,
  resolvePiAcpBaseModelId,
  type PiCatalogModelEntry,
  type PiThinkingLevelsByModel,
} from "../acp/PiAcpSupport.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PI_CATALOG_STORE_PATH = ".pi/agent/models-store.json";
const PI_CATALOG_LOCAL_PATH = ".pi/agent/models.json";
const PI_AGENT_AUTH_PATH = ".pi/agent/auth.json";
const PI_AGENT_SETTINGS_PATH = ".pi/agent/settings.json";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const PI_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "pi-default",
    name: "Pi Default Model",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking pi availability...",
      },
    });
  });
}

function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = PI_FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildPiDiscoveredModelsFromConfigOptions(input: {
  readonly currentValue: string | undefined;
  readonly availableModels: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly reasoning: ReturnType<typeof piReasoningOptionsFromThoughtLevels>;
  readonly thoughtLevelConfigId: string | undefined;
  readonly thinkingLevelsByModel: PiThinkingLevelsByModel;
}): ReadonlyArray<ServerProviderModel> {
  if (input.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  // The user's configured default leads the picker; everything else follows.
  const ordered = input.currentValue
    ? [
        ...input.availableModels.filter((model) => model.value === input.currentValue),
        ...input.availableModels.filter((model) => model.value !== input.currentValue),
      ]
    : input.availableModels;
  const reasoningDescriptors = input.reasoning.options;
  const buildCapabilities = (modelValue: string): ModelCapabilities => {
    // Per-model levels win when pi's catalog maps them (e.g. GLM only
    // supports low/high/max); otherwise fall back to the generic session list.
    const supportedLevels = piSupportedReasoningLevels(input.thinkingLevelsByModel, modelValue);
    const options = (supportedLevels ?? reasoningDescriptors.map((option) => option.value)).map(
      (value) => ({
        id: value,
        label: value,
        ...(value === input.reasoning.currentValue ? { isDefault: true } : {}),
      }),
    );
    if (options.length === 0) {
      return EMPTY_CAPABILITIES;
    }
    return createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options,
          ...(input.reasoning.currentValue ? { currentValue: input.reasoning.currentValue } : {}),
        },
      ],
    });
  };
  for (const model of ordered) {
    const slug = resolvePiAcpBaseModelId(model.value);
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: model.name.trim() || slug,
      isCustom: false,
      capabilities: buildCapabilities(model.value),
    });
  }
  return models;
}

const PiCatalogModel = Schema.Struct({
  id: Schema.String,
  thinkingLevelMap: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});

export interface PiCatalogContext {
  /** `"provider/model" -> wire levels` for models pi documents a map for. */
  readonly thinkingLevelsByModel: PiThinkingLevelsByModel;
  /** Providers pi considers configured: logged in (auth.json) or user-defined (models.json), plus the default provider. */
  readonly allowedProviders: ReadonlySet<string>;
}

/**
 * Reads pi's local config to scope what T3 exposes. pi advertises every model
 * in its catalog (including unauthenticated ones like OpenRouter's public
 * list), which buries the user's actual setup — T3 keeps only providers that
 * are logged in, user-defined, or pi's default.
 */
const readPiCatalogContext = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = process.env.HOME?.trim() || process.env.PI_DIR?.trim();
  const empty: PiCatalogContext = {
    thinkingLevelsByModel: new Map<string, ReadonlyArray<string>>() as PiThinkingLevelsByModel,
    allowedProviders: new Set<string>(),
  };
  if (!home) {
    return empty;
  }
  const readJson = (relative: string): Record<string, unknown> | undefined => {
    try {
      const content = NodeFS.readFileSync(path.join(home, relative), "utf8");
      if (!content.trim()) {
        return undefined;
      }
      const parsed: unknown = JSON.parse(content);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const store = readJson(PI_CATALOG_STORE_PATH);
  const localFile = readJson(PI_CATALOG_LOCAL_PATH);
  const localProviders =
    typeof localFile?.providers === "object" && localFile.providers !== null
      ? (localFile.providers as Record<string, unknown>)
      : undefined;
  const auth = readJson(PI_AGENT_AUTH_PATH);
  const settings = readJson(PI_AGENT_SETTINGS_PATH);

  const allowedProviders = new Set<string>();
  for (const key of Object.keys(auth ?? {})) {
    allowedProviders.add(key);
  }
  for (const key of Object.keys(localProviders ?? {})) {
    allowedProviders.add(key);
  }
  if (typeof settings?.defaultProvider === "string") {
    allowedProviders.add(settings.defaultProvider);
  }

  // thinkingLevelMap entries: models-store.json is a bare provider map;
  // models.json wraps providers in a `providers` key.
  const entries: Array<PiCatalogModelEntry> = [];
  const scanProviderModels = (provider: string, models: unknown): void => {
    if (!Array.isArray(models)) {
      return;
    }
    for (const raw of models) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.thinkingLevelMap !== "object" ||
        record.thinkingLevelMap === null
      ) {
        continue;
      }
      const map: Record<string, string | null> = {};
      for (const [level, mapped] of Object.entries(record.thinkingLevelMap)) {
        map[level] = typeof mapped === "string" ? mapped : null;
      }
      entries.push({ provider, id: record.id, thinkingLevelMap: map });
    }
  };
  for (const [provider, entry] of Object.entries(store ?? {})) {
    const shape =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    scanProviderModels(provider, shape.models);
  }
  for (const [provider, entry] of Object.entries(localProviders ?? {})) {
    const shape =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    scanProviderModels(provider, shape.models);
  }

  const result = {
    thinkingLevelsByModel: piThinkingLevelsFromCatalogEntries(entries),
    allowedProviders,
  };
  try {
    NodeFS.writeFileSync(
      "/tmp/pi-dbg.txt",
      JSON.stringify({
        home,
        allowed: [...allowedProviders],
        entries: entries.length,
        mapSize: result.thinkingLevelsByModel.size,
        glm: result.thinkingLevelsByModel.get("zai/glm-5.3"),
      }),
    );
  } catch {}
  return result;
});

const discoverPiModelsViaAcp = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makePiAcpRuntime({
      piSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const modelConfig = piModelConfigOptionFromConfigOptions(
      started.sessionSetupResult.configOptions,
    );
    if (!modelConfig) {
      return [];
    }
    const thoughtLevel = piThoughtLevelConfigOptionFromConfigOptions(
      started.sessionSetupResult.configOptions,
    );
    const reasoning = piReasoningOptionsFromThoughtLevels({
      availableLevels: thoughtLevel?.availableLevels ?? [],
      currentValue: thoughtLevel?.currentValue,
    });
    const catalog = yield* readPiCatalogContext;
    // pi advertises its whole catalog; keep only providers the user actually
    // has configured (authed or user-defined) so the picker stays honest.
    const configuredModels = modelConfig.availableModels.filter(
      (model) =>
        !model.value.includes("/") ||
        catalog.allowedProviders.has(model.value.slice(0, model.value.indexOf("/"))),
    );
    try {
      NodeFS.writeFileSync(
        "/tmp/pi-dbg2.txt",
        JSON.stringify({
          advertised: modelConfig.availableModels.length,
          configured: configuredModels.length,
          firstAdvertised: modelConfig.availableModels.slice(0, 3).map((m) => m.value),
        }),
      );
    } catch {}
    return buildPiDiscoveredModelsFromConfigOptions({
      currentValue: modelConfig.currentValue,
      availableModels: configuredModels.length > 0 ? configuredModels : modelConfig.availableModels,
      reasoning,
      thoughtLevelConfigId: thoughtLevel?.configId,
      thinkingLevelsByModel: catalog.thinkingLevelsByModel,
    });
  }).pipe(Effect.scoped);

const runPiVersionCommand = (
  _piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    // The adapter requires `pi` on PATH anyway (it spawns pi --mode rpc), so
    // the harness binary is the meaningful version to display.
    const spawnCommand = yield* resolveSpawnCommand("pi", ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      "pi",
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Path.Path
> {
  void cwd;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("pi health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute pi health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "pi is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("pi version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "pi is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverPiModelsViaAcp(piSettings, environment).pipe(
    Effect.timeoutOption(PI_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("pi ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "pi is installed but the ACP adapter failed to start. Is `pi-acp` installed (`npm i -g pi-acp`) and up to date?",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `pi ACP model discovery timed out after ${PI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `pi is installed but ACP startup timed out after ${PI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discoveredModels = discoveryExit.value.value;
  // ponytail: pi advertises every catalog model (364 on this box) — capped for
  // wire size; raise the cap or filter by provider prefix once users ask.
  const cappedModels = discoveredModels.slice(0, 100);
  const models =
    cappedModels.length > 0
      ? piModelsFromSettings(piSettings.customModels, cappedModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
