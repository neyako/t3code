import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyPiAcpModelSelection,
  applyPiAcpReasoningSelection,
  buildPiAcpSpawnInput,
  piModelConfigOptionFromConfigOptions,
  piReasoningOptionsFromThoughtLevels,
  piSupportedReasoningLevels,
  piThinkingLevelsFromCatalogEntries,
  piThoughtLevelConfigOptionFromConfigOptions,
  resolvePiAcpBaseModelId,
} from "./PiAcpSupport.ts";

describe("resolvePiAcpBaseModelId", () => {
  it("normalizes empty and custom pi model ids", () => {
    expect(resolvePiAcpBaseModelId(undefined)).toBe("pi-default");
    expect(resolvePiAcpBaseModelId("   ")).toBe("pi-default");
    expect(resolvePiAcpBaseModelId("  zai/glm-5.3  ")).toBe("zai/glm-5.3");
  });
});

describe("buildPiAcpSpawnInput", () => {
  it("spawns the pi-acp adapter from PATH by default", () => {
    const input = buildPiAcpSpawnInput({ binaryPath: "" }, "/tmp/work", { FOO: "bar" });
    expect(input.command).toBe("pi-acp");
    expect(input.args).toEqual([]);
    expect(input.cwd).toBe("/tmp/work");
    expect(input.env).toEqual({ FOO: "bar" });
  });

  it("uses the configured adapter binary path", () => {
    const input = buildPiAcpSpawnInput({ binaryPath: "/usr/local/bin/pi-acp" }, "/tmp/work");
    expect(input.command).toBe("/usr/local/bin/pi-acp");
  });
});

describe("piModelConfigOptionFromConfigOptions", () => {
  it("finds the model select option and its catalog", () => {
    const parsed = piModelConfigOptionFromConfigOptions([
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "zai/glm-5.3",
        options: [
          { value: "zai/glm-5.3", name: "GLM 5.3" },
          { value: "openrouter/foo", name: "Foo" },
        ],
      } as never,
    ]);
    expect(parsed?.configId).toBe("model");
    expect(parsed?.currentValue).toBe("zai/glm-5.3");
    expect(parsed?.availableModels).toEqual([
      { value: "zai/glm-5.3", name: "GLM 5.3" },
      { value: "openrouter/foo", name: "Foo" },
    ]);
  });

  it("returns undefined when no model option exists", () => {
    expect(piModelConfigOptionFromConfigOptions([])).toBeUndefined();
    expect(piModelConfigOptionFromConfigOptions(undefined)).toBeUndefined();
  });

  it("flattens grouped options and skips group headers", () => {
    const parsed = piModelConfigOptionFromConfigOptions([
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "b",
        options: [
          {
            group: "grp",
            name: "Group",
            options: [
              { value: "a", name: "A" },
              { value: "b", name: "B" },
            ],
          },
        ],
      } as never,
    ]);
    expect(parsed?.availableModels).toEqual([
      { value: "a", name: "A" },
      { value: "b", name: "B" },
    ]);
  });
});

describe("piThoughtLevelConfigOptionFromConfigOptions", () => {
  const thoughtLevels = [
    { value: "off", name: "Thinking: off" },
    { value: "high", name: "Thinking: high" },
  ];

  it("finds the thought_level select option", () => {
    const parsed = piThoughtLevelConfigOptionFromConfigOptions([
      {
        type: "select",
        id: "thought_level",
        name: "Thought level",
        category: "thought_level",
        currentValue: "high",
        options: thoughtLevels,
      } as never,
    ]);
    expect(parsed?.configId).toBe("thought_level");
    expect(parsed?.currentValue).toBe("high");
    expect(parsed?.availableLevels).toEqual(thoughtLevels);
  });

  it("returns undefined when absent", () => {
    expect(piThoughtLevelConfigOptionFromConfigOptions([])).toBeUndefined();
  });
});

describe("piReasoningOptionsFromThoughtLevels", () => {
  it("maps levels to reasoning options with the current default", () => {
    const reasoning = piReasoningOptionsFromThoughtLevels({
      availableLevels: [
        { value: "off", name: "Thinking: off" },
        { value: "high", name: "Thinking: high" },
      ],
      currentValue: "high",
    });
    expect(reasoning.options).toEqual([
      { value: "off", label: "Thinking: off" },
      { value: "high", label: "Thinking: high", isDefault: true },
    ]);
    expect(reasoning.currentValue).toBe("high");
  });

  it("returns empty options when no levels exist", () => {
    expect(
      piReasoningOptionsFromThoughtLevels({ availableLevels: [], currentValue: undefined }),
    ).toEqual({ options: [], currentValue: undefined });
  });
});

describe("applyPiAcpReasoningSelection", () => {
  const makeRuntime = (calls: string[]) => ({
    setConfigOption: (configId: string, value: string) => {
      calls.push(`${configId}=${value}`);
      return Effect.void as never;
    },
  });

  it("skips the write when no thought_level option exists", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      applyPiAcpReasoningSelection({
        runtime: makeRuntime(calls) as never,
        thoughtLevelConfigId: undefined,
        currentReasoning: "high",
        requestedReasoning: "low",
        mapError: (cause) => cause,
      }),
    );
    expect(result).toBe("high");
    expect(calls).toEqual([]);
  });

  it("writes the requested level through setConfigOption", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      applyPiAcpReasoningSelection({
        runtime: makeRuntime(calls) as never,
        thoughtLevelConfigId: "thought_level",
        currentReasoning: "high",
        requestedReasoning: "low",
        mapError: (cause) => cause,
      }),
    );
    expect(result).toBe("low");
    expect(calls).toEqual(["thought_level=low"]);
  });

  it("skips the write when the level is unchanged", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      applyPiAcpReasoningSelection({
        runtime: makeRuntime(calls) as never,
        thoughtLevelConfigId: "thought_level",
        currentReasoning: "low",
        requestedReasoning: "low",
        mapError: (cause) => cause,
      }),
    );
    expect(result).toBe("low");
    expect(calls).toEqual([]);
  });
});

describe("piThinkingLevelsFromCatalogEntries", () => {
  it("indexes the mapped levels per provider/model", () => {
    const index = piThinkingLevelsFromCatalogEntries([
      {
        provider: "zai",
        id: "glm-5.3",
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      },
      { provider: "zai", id: "no-map" },
    ]);
    expect(piSupportedReasoningLevels(index, "zai/glm-5.3")).toEqual(["low", "high", "max"]);
    expect(piSupportedReasoningLevels(index, "zai/no-map")).toBeUndefined();
    expect(piSupportedReasoningLevels(index, "unknown/model")).toBeUndefined();
  });
});

describe("applyPiAcpModelSelection", () => {
  it("returns the current model unchanged when nothing is requested", async () => {
    let setModelCalls = 0;
    const result = await Effect.runPromise(
      applyPiAcpModelSelection({
        runtime: {
          setModel: () => {
            setModelCalls += 1;
            return Effect.void;
          },
        },
        currentModelId: "zai/glm-5.3",
        requestedModelId: undefined,
        mapError: (cause) => cause,
      }),
    );
    expect(result).toBe("zai/glm-5.3");
    expect(setModelCalls).toBe(0);
  });

  it("switches via setModel when the requested model differs", async () => {
    const requested: string[] = [];
    const result = await Effect.runPromise(
      applyPiAcpModelSelection({
        runtime: {
          setModel: (model: string) => {
            requested.push(model);
            return Effect.void;
          },
        },
        currentModelId: "zai/glm-5.3",
        requestedModelId: "openrouter/foo",
        mapError: (cause) => cause,
      }),
    );
    expect(result).toBe("openrouter/foo");
    expect(requested).toEqual(["openrouter/foo"]);
  });
});
