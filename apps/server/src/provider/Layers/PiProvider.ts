// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { parse as parseYamlDocument } from "yaml";

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

function trimOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parsePiAvailableCommands(
  input: ReadonlyArray<unknown>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const name = trimOptional(record.name)?.replace(/^\/+/, "");
    if (!name) continue;
    const description = trimOptional(record.description);
    const inputRecord =
      record.input && typeof record.input === "object"
        ? (record.input as Record<string, unknown>)
        : undefined;
    const hint = trimOptional(inputRecord?.hint);
    const key = name.toLowerCase();
    const previous = byName.get(key);
    byName.set(key, {
      name: previous?.name ?? name,
      ...(previous?.description
        ? { description: previous.description }
        : description
          ? { description }
          : {}),
      ...(previous?.input?.hint ? { input: previous.input } : hint ? { input: { hint } } : {}),
    });
  }
  return [...byName.values()];
}

export function discoverPiSkillsFromFilesystem(
  home: string,
  cwd: string,
  configuredAgentDir?: string,
): ReadonlyArray<ServerProviderSkill> {
  const resolvedHome = home.trim() || NodeOS.homedir();
  const resolvedCwd = NodePath.resolve(cwd);
  const resolvedAgentDir = configuredAgentDir?.trim()
    ? (() => {
        const value = configuredAgentDir.startsWith("~/")
          ? NodePath.join(resolvedHome, configuredAgentDir.slice(2))
          : configuredAgentDir;
        return NodePath.isAbsolute(value)
          ? NodePath.resolve(value)
          : NodePath.resolve(resolvedCwd, value);
      })()
    : NodePath.join(resolvedHome, ".pi", "agent");
  const roots: Array<{ path: string; scope: "user" | "project"; includeRootFiles: boolean }> = [];
  const rootPaths = new Set<string>();
  const addRoot = (path: string, scope: "user" | "project", includeRootFiles = true) => {
    const resolved = NodePath.resolve(path);
    if (rootPaths.has(resolved)) return;
    rootPaths.add(resolved);
    roots.push({ path: resolved, scope, includeRootFiles });
  };
  addRoot(NodePath.join(resolvedAgentDir, "skills"), "user");
  addRoot(NodePath.join(resolvedHome, ".agents", "skills"), "user", false);

  const projectDirs: string[] = [];
  for (let directory = resolvedCwd; ; directory = NodePath.dirname(directory)) {
    projectDirs.push(directory);
    if (NodeFS.existsSync(NodePath.join(directory, ".git"))) break;
    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
  }
  for (const directory of projectDirs) {
    addRoot(NodePath.join(directory, ".pi", "skills"), "project");
    addRoot(NodePath.join(directory, ".agents", "skills"), "project", false);
  }

  const expandConfiguredPath = (value: string, base: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("-")) return undefined;
    const path = trimmed.startsWith("+") || trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
    const resolved = path.startsWith("~/") ? NodePath.join(resolvedHome, path.slice(2)) : path;
    return NodePath.isAbsolute(resolved)
      ? NodePath.resolve(resolved)
      : NodePath.resolve(base, resolved);
  };
  const readSettings = (path: string): ReadonlyArray<string> | undefined => {
    try {
      const settings = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
      return Array.isArray(settings.skills)
        ? settings.skills.filter((entry): entry is string => typeof entry === "string")
        : undefined;
    } catch {
      return undefined;
    }
  };
  const globalConfigured = readSettings(NodePath.join(resolvedAgentDir, "settings.json"));
  const projectConfigured = readSettings(NodePath.join(resolvedCwd, ".pi", "settings.json"));
  for (const entry of globalConfigured ?? []) {
    const path = expandConfiguredPath(entry, resolvedAgentDir);
    if (path) addRoot(path, "user");
  }
  for (const entry of projectConfigured ?? []) {
    const path = expandConfiguredPath(entry, resolvedCwd);
    if (path) addRoot(path, "project");
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  const visited = new Set<string>();
  const parseSkill = (filePath: string, scope: "user" | "project") => {
    const canonicalPath = NodePath.resolve(filePath);
    if (visited.has(canonicalPath)) return;
    visited.add(canonicalPath);
    let text: string;
    try {
      text = NodeFS.readFileSync(canonicalPath, "utf8");
    } catch {
      return;
    }
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return;
    let metadata: unknown;
    try {
      metadata = parseYamlDocument(match[1] ?? "");
    } catch {
      return;
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return;
    const record = metadata as Record<string, unknown>;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (!description) return;
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : NodePath.basename(NodePath.dirname(canonicalPath));
    if (!name || skillsByName.has(name)) return;
    skillsByName.set(name, {
      name,
      description,
      path: canonicalPath,
      enabled: true,
      scope,
      shortDescription: description,
    });
  };
  const scan = (directory: string, scope: "user" | "project", includeRootFiles: boolean) => {
    const resolved = NodePath.resolve(directory);
    if (visited.has(resolved)) return;
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(resolved, { withFileTypes: true });
    } catch {
      return;
    }
    const declaredSkill = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
    if (declaredSkill) {
      parseSkill(NodePath.join(resolved, declaredSkill.name), scope);
      return;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = NodePath.join(resolved, entry.name);
      if (entry.isDirectory()) {
        scan(path, scope, false);
      } else if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) {
        parseSkill(path, scope);
      }
    }
  };
  for (const root of roots) scan(root.path, root.scope, root.includeRootFiles);
  return [...skillsByName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

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
  return result;
});

const discoverPiModelsViaAcp = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makePiAcpRuntime({
      piSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const commandEvent = yield* Stream.runHead(
      Stream.filter(acp.getEvents(), (event) => event._tag === "AvailableCommandsUpdated"),
    ).pipe(Effect.timeoutOption(5_000), Effect.map(Option.flatten));
    const slashCommands = Option.isSome(commandEvent)
      ? parsePiAvailableCommands(
          (
            commandEvent.value as {
              readonly availableCommands?: ReadonlyArray<unknown>;
            }
          ).availableCommands ?? [],
        )
      : [];
    const modelConfig = piModelConfigOptionFromConfigOptions(
      started.sessionSetupResult.configOptions,
    );
    if (!modelConfig) {
      return {
        models: [],
        slashCommands,
        skills: discoverPiSkillsFromFilesystem(
          environment.HOME ?? "",
          cwd,
          environment.PI_CODING_AGENT_DIR,
        ),
      };
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
    const models = buildPiDiscoveredModelsFromConfigOptions({
      currentValue: modelConfig.currentValue,
      availableModels: configuredModels.length > 0 ? configuredModels : modelConfig.availableModels,
      reasoning,
      thoughtLevelConfigId: thoughtLevel?.configId,
      thinkingLevelsByModel: catalog.thinkingLevelsByModel,
    });
    return {
      models,
      slashCommands,
      skills: discoverPiSkillsFromFilesystem(
        environment.HOME ?? "",
        cwd,
        environment.PI_CODING_AGENT_DIR,
      ),
    };
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
  cwd = cwd ?? process.cwd();
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

  const discoveryExit = yield* discoverPiModelsViaAcp(piSettings, environment, cwd).pipe(
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
  const discovered = discoveryExit.value.value;
  const discoveredModels = discovered.models;
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
    slashCommands: discovered.slashCommands,
    skills: discovered.skills,
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
