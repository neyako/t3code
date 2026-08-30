import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyPiAcpModelSelection,
  buildPiAcpSpawnInput,
  piModelConfigOptionFromConfigOptions,
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
