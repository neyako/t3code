import { describe, expect, it } from "vite-plus/test";
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
        path: `${personal}/SKILL.md`,
        enabled: true,
        scope: "user",
        shortDescription: "First",
      },
      {
        name: "two",
        description: "Second",
        path: `${project}/SKILL.md`,
        enabled: true,
        scope: "project",
        shortDescription: "Second",
      },
    ]);
  });

  it("matches Pi skill roots, recursive discovery, and configured paths", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-roots-"));
    const home = path.join(root, "home");
    const project = path.join(root, "repo", "packages", "app");
    const repoRoot = path.join(root, "repo");
    const globalAgents = path.join(home, ".agents", "skills", "global-only");
    const projectPi = path.join(repoRoot, ".pi", "skills");
    const projectAgents = path.join(repoRoot, ".agents", "skills", "group", "nested");
    const configured = path.join(home, "extra-skills", "configured");
    await Promise.all([
      fs.mkdir(globalAgents, { recursive: true }),
      fs.mkdir(projectPi, { recursive: true }),
      fs.mkdir(projectAgents, { recursive: true }),
      fs.mkdir(configured, { recursive: true }),
      fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true }),
      fs.mkdir(path.join(repoRoot, ".git"), { recursive: true }),
      fs.mkdir(path.join(project, ".pi"), { recursive: true }),
    ]);
    await fs.writeFile(
      path.join(globalAgents, "SKILL.md"),
      "---\nname: global-only\ndescription: Global\n---\n",
    );
    await fs.writeFile(
      path.join(projectPi, "direct.md"),
      "---\nname: direct\ndescription: Direct\n---\n",
    );
    await fs.writeFile(
      path.join(projectAgents, "SKILL.md"),
      "---\nname: nested\ndescription: Nested\n---\n",
    );
    await fs.writeFile(
      path.join(configured, "SKILL.md"),
      "---\nname: configured\ndescription: Configured\n---\n",
    );
    await fs.writeFile(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ skills: ["~/extra-skills"] }),
    );

    expect(discoverPiSkillsFromFilesystem(home, project)).toEqual([
      {
        name: "configured",
        description: "Configured",
        path: path.join(configured, "SKILL.md"),
        enabled: true,
        scope: "user",
        shortDescription: "Configured",
      },
      {
        name: "direct",
        description: "Direct",
        path: path.join(projectPi, "direct.md"),
        enabled: true,
        scope: "project",
        shortDescription: "Direct",
      },
      {
        name: "global-only",
        description: "Global",
        path: path.join(globalAgents, "SKILL.md"),
        enabled: true,
        scope: "user",
        shortDescription: "Global",
      },
      {
        name: "nested",
        description: "Nested",
        path: path.join(projectAgents, "SKILL.md"),
        enabled: true,
        scope: "project",
        shortDescription: "Nested",
      },
    ]);
  });

  it("combines global and project skill settings", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-settings-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const globalSkill = path.join(home, "global-skill");
    const projectSkill = path.join(root, "project-skill");
    await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.mkdir(path.join(globalSkill), { recursive: true });
    await fs.mkdir(path.join(projectSkill), { recursive: true });
    await fs.writeFile(
      path.join(globalSkill, "SKILL.md"),
      "---\nname: global-configured\ndescription: Global\n---\n",
    );
    await fs.writeFile(
      path.join(projectSkill, "SKILL.md"),
      "---\nname: project-configured\ndescription: Project\n---\n",
    );
    await fs.writeFile(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ skills: ["../../global-skill"] }),
    );
    await fs.writeFile(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ skills: ["../project-skill"] }),
    );

    expect(discoverPiSkillsFromFilesystem(home, cwd).map((skill) => skill.name)).toEqual([
      "global-configured",
      "project-configured",
    ]);
  });
});
