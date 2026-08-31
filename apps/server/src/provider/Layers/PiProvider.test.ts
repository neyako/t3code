import { describe, expect, it } from "vitest";
import { parsePiAvailableCommands, discoverPiSkillsFromFilesystem } from "./PiProvider.ts";

describe("Pi provider discovery", () => {
  it("normalizes and deduplicates ACP commands", () => {
    expect(
      parsePiAvailableCommands([
        { name: " /help ", description: "Help" },
        { name: "help", description: "", input: { hint: "topic" } },
        { name: "/skill:review", description: "Review" },
        { name: "", description: "ignored" },
      ]),
    ).toEqual([
      { name: "help", description: "Help", input: { hint: "topic" } },
      { name: "skill:review", description: "Review" },
    ]);
  });

  it("discovers skill metadata with project and personal roots", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-"));
    const personal = path.join(root, "home", ".pi", "agent", "skills", "one");
    const project = path.join(root, "project", "skills", "two");
    await fs.mkdir(personal, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(root, "project", ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(personal, "SKILL.md"),
      "---\nname: one\ndescription: First\n---\n",
    );
    await fs.writeFile(
      path.join(project, "SKILL.md"),
      "---\nname: two\ndescription: Second\n---\n",
    );
    await fs.writeFile(
      path.join(root, "project", ".pi", "settings.json"),
      JSON.stringify({ skills: ["skills"] }),
    );
    expect(
      discoverPiSkillsFromFilesystem(path.join(root, "home"), path.join(root, "project")),
    ).toEqual([
      {
        name: "one",
        description: "First",
        path: personal,
        enabled: true,
        scope: "user",
        shortDescription: "First",
      },
      {
        name: "two",
        description: "Second",
        path: project,
        enabled: true,
        scope: "project",
        shortDescription: "Second",
      },
    ]);
  });
});
