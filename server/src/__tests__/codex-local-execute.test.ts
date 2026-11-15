import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "@paperclipai/adapter-codex-local/server";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";
import { AGENT_CHAT_DIRECTIVE } from "../services/agent-conversations.js";

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  codexHome: process.env.CODEX_HOME || null,
  codexConfigContents: process.env.CODEX_HOME && fs.existsSync(process.env.CODEX_HOME + "/config.toml")
    ? fs.readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8")
    : null,
  paperclipWakePayloadJson: process.env.PAPERCLIP_WAKE_PAYLOAD_JSON || null,
  paperclipApiUrl: process.env.PAPERCLIP_API_URL || null,
  paperclipApiKey: process.env.PAPERCLIP_API_KEY || null,
  paperclipApiBridgeMode: process.env.PAPERCLIP_API_BRIDGE_MODE || null,
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFailingCodexCommand(commandPath: string, errorMessage: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "error", message: ${JSON.stringify(errorMessage)} }));
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  codexHome: string | null;
  codexConfigContents?: string | null;
  paperclipWakePayloadJson: string | null;
  paperclipApiUrl?: string | null;
  paperclipApiKey?: string | null;
  paperclipApiBridgeMode?: string | null;
  paperclipEnvKeys: string[];
};

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

const fakeCodexAuthJson = JSON.stringify({ OPENAI_API_KEY: "sk-test-codex-local" });

const codexHomeOverrides: Array<string | undefined> = [];

afterEach(() => {
  while (codexHomeOverrides.length > 0) {
    const previous = codexHomeOverrides.pop();
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

async function seedSharedCodexAuth(homeRoot: string): Promise<void> {
  const sharedCodexHome = path.join(homeRoot, ".codex");
  codexHomeOverrides.push(process.env.CODEX_HOME);
  process.env.CODEX_HOME = sharedCodexHome;
  await fs.mkdir(sharedCodexHome, { recursive: true });
  await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
}

function createLocalSandboxRunner() {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      return runChildProcess(
        `sandbox-run-${counter}`,
        input.command,
        input.args ?? [],
        {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn
            ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
            : undefined,
        },
      );
    },
  };
}

describe("codex execute", () => {
  it("uses a Paperclip-managed CODEX_HOME outside worktree mode while preserving shared auth and config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-default-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-default",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.usage).toEqual({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
      expect(result.usageBasis).toBe("per_run");
      expect(result.costUsd).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(managedCodexHome);

      const managedAuth = path.join(managedCodexHome, "auth.json");
      const managedConfig = path.join(managedCodexHome, "config.toml");
      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(managedConfig)).isFile()).toBe(true);
      expect(await fs.readFile(managedConfig, "utf8")).toBe('model = "codex-mini-latest"\n');
      await expect(fs.lstat(path.join(sharedCodexHome, "companies", "company-1"))).rejects.toThrow();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using Paperclip-managed Codex home"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("writes managed MCP gateways into Codex config and warns on overlapping direct entries without logging tokens", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-managed-mcp-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "codex-mini-latest"',
        "",
        '[mcp_servers.github]',
        'url = "https://raw.example/mcp"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    const previousPaperclipRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_API_URL = "http://paperclip.local:3100";
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.local:3100";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-managed-mcp",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        runtimeMcp: {
          getServers: () => [
            {
              name: "github",
              url: "http://paperclip.local:3100/api/tool-gateway/gateways/gateway-1/mcp",
              token: "pcgw_secret-managed-token",
              connectionId: "connection-github",
            },
          ],
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      const configText = capture.codexConfigContents ?? "";
      expect(configText).toContain("[mcp_servers.github]");
      expect(configText).toContain("[mcp_servers.\"paperclip-github\"]");
      expect(configText).toContain('url = "http://paperclip.local:3100/api/tool-gateway/gateways/gateway-1/mcp"');
      expect(configText).toContain('Authorization = "Bearer pcgw_secret-managed-token"');
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stream: "stderr",
            chunk: expect.stringContaining("Paperclip cannot enforce policies for that direct entry"),
          }),
        ]),
      );
      expect(JSON.stringify(logs)).not.toContain("pcgw_secret-managed-token");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = previousPaperclipApiUrl;
      if (previousPaperclipRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
      else process.env.PAPERCLIP_RUNTIME_API_URL = previousPaperclipRuntimeApiUrl;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits a command note that Codex auto-applies repo-scoped AGENTS.md files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-notes-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    let commandNotes: string[] = [];
    try {
      const result = await execute({
        runId: "run-notes",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(commandNotes).toContain(
        "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.",
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs HOME and the resolved executable path in invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-meta-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    await seedSharedCodexAuth(root);

    let loggedCommand: string | null = null;
    let loggedEnv: Record<string, string> = {};
    try {
      const result = await execute({
        runId: "run-meta",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: "codex",
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedCommand = meta.command;
          loggedEnv = meta.env ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(loggedCommand).toBe(commandPath);
      expect(loggedEnv.HOME).toBe(root);
      expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(commandPath);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects bridge env into sandbox-managed remote runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-sandbox-"));
    const localWorkspace = path.join(root, "workspace");
    const remoteWorkspace = path.join(root, "sandbox");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    const capturePath = path.join(remoteWorkspace, "capture.json");
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;

    await fs.mkdir(localWorkspace, { recursive: true });
    await fs.mkdir(remoteWorkspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-sandbox-auth",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: localWorkspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "e2b",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: remoteWorkspace,
          timeoutMs: 30_000,
          runner: createLocalSandboxRunner(),
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(path.join(remoteWorkspace, ".paperclip-runtime", "codex", "home"));
      expect(capture.paperclipApiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(capture.paperclipApiKey).not.toBe("run-jwt-token");
      expect(capture.paperclipApiBridgeMode).toBe("queue_v1");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("delivers oversized wake context through stdin (sandbox=%s)", async (sandbox) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const description = "begin " + "full wake context ".repeat(16_384) + " end";
    expect(Buffer.byteLength(description)).toBeGreaterThan(128 * 1024);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_WAKE_PAYLOAD_JSON: description,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          paperclipWake: {
            reason: "issue_commented",
            issue: {
              id: "issue-1",
              identifier: "PAP-874",
              title: "Wake context test",
              description,
              status: "in_progress",
              priority: "medium",
            },
            commentIds: ["comment-1", "comment-2"],
            latestCommentId: "comment-2",
            comments: [
              {
                id: "comment-1",
                issueId: "issue-1",
                body: "First comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:00.000Z",
                author: { type: "user", id: "user-1" },
              },
              {
                id: "comment-2",
                issueId: "issue-1",
                body: "Second comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:10.000Z",
                author: { type: "user", id: "user-1" },
              },
            ],
            commentWindow: {
              requestedCount: 2,
              includedCount: 2,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        executionTarget: sandbox ? {
          kind: "remote",
          transport: "sandbox",
          providerKey: "test",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: workspace,
          timeoutMs: 30_000,
          runner: createLocalSandboxRunner(),
        } : undefined,
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).not.toContain("PAPERCLIP_WAKE_PAYLOAD_JSON");
      expect(capture.paperclipWakePayloadJson).toBeNull();
      expect(capture.prompt).toContain(description);
      expect(capture.prompt).toContain("- reason: issue_commented");
      expect(capture.prompt).toContain("## Paperclip Wake Payload");
      expect(capture.prompt).toContain("Use this wake to continue the task, applying new user direction and preserving its approval gates.");
      expect(capture.prompt).toContain("Do not switch to another issue until you have handled this wake.");
      expect(capture.prompt).toContain(
        "acknowledge the latest comment and explain how it changes your next action.",
      );
      expect(capture.prompt).toContain("First comment");
      expect(capture.prompt).toContain("Second comment");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps real assignment markdown and current wake events single-owned at the CLI boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-context-owner-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);
    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: "issue-1", identifier: "PAP-900", title: "Repeat phrase Repeat phrase", description: "Repeat phrase Repeat phrase" },
      wakeComments: [
        { id: "comment-a", body: "Same event body." },
        { id: "comment-b", body: "Same event body." },
      ],
      includeWakeComments: false,
    });
    const historicalMarkdown = buildPaperclipTaskMarkdown({
      issue: { id: "issue-1", identifier: "PAP-900", title: "Repeat phrase Repeat phrase", description: "Repeat phrase Repeat phrase" },
      wakeComments: [
        { id: "comment-a", body: "Same event body." },
        { id: "comment-b", body: "Same event body." },
      ],
    });
    try {
      await execute({
        runId: "run-context-owner",
        agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli", command: commandPath, cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Custom template keeps {{paperclipTaskMarkdown}} and {{paperclipWakePrompt}}.",
        },
        context: {
          issueId: "issue-1",
          paperclipTaskMarkdown: historicalMarkdown,
          paperclipTaskMarkdownAssignment: markdown,
          paperclipWake: {
            reason: "issue_commented",
            issue: { id: "issue-1", identifier: "PAP-900", title: "Repeat phrase Repeat phrase", description: "Repeat phrase Repeat phrase", status: "in_progress" },
            executionContinuation: {
              version: 1,
              companyId: "company-1",
              issueId: "issue-1",
              trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
              originCommentIds: [],
              objective: "Repeat phrase Repeat phrase",
              objectiveSource: { kind: "description", id: "issue-1", revision: "2e2ed64c2ca5be0343f591d037a6f40a0b9cee733fedb7fdafa69e4158299957" },
              messages: [],
              interactionOutcomes: [],
              completedWork: null,
              unresolvedInteractionIds: [],
              coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
            },
            comments: [
              { id: "comment-a", issueId: "issue-1", body: "Same event body.", bodyTruncated: false, createdAt: "2026-09-21T00:00:00.000Z" },
              { id: "comment-b", issueId: "issue-1", body: "Same event body.", bodyTruncated: false, createdAt: "2026-09-21T00:01:00.000Z" },
            ],
            commentWindow: { requestedCount: 2, includedCount: 2, missingCount: 0 },
            fallbackFetchNeeded: false,
          },
          paperclipTurnContext: { version: 1, assignment: { owner: "task_markdown" }, events: { owner: "wake_prompt", comments: [{ id: "comment-a", revision: "a" }, { id: "comment-b", revision: "b" }] } },
        },
        onLog: async () => {},
      });
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt).toContain("Custom template keeps");
      expect(capture.prompt).toContain("comment-a");
      expect(capture.prompt.indexOf("comment-a")).toBeLessThan(capture.prompt.indexOf("comment-b"));
      expect(capture.prompt.split("Same event body.")).toHaveLength(3);
      // The custom template intentionally repeats task context; ownership only
      // removes automatic wake-event duplication.
      expect(capture.prompt.split("Repeat phrase Repeat phrase")).toHaveLength(4);
      expect(capture.prompt).not.toContain('"objective":"Repeat phrase Repeat phrase"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies remote-compaction high-demand failures as retryable transient upstream errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-transient-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(
      commandPath,
      "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-transient-error",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("codex_transient_upstream");
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.errorMessage).toContain("high demand");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])("retries missing resume only before a session starts (started=%s)", async (started) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-resume-stop-"));
    const commandPath = path.join(root, "codex");
    const attemptsPath = path.join(root, "attempts");
    await seedSharedCodexAuth(root);
    await fs.writeFile(commandPath, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(attemptsPath)}, "attempt\\n");
if (process.argv.includes("resume")) {
  console.error("state db missing rollout path for thread unrelated-old-thread");
  ${started ? 'console.log(JSON.stringify({ type: "thread.started", thread_id: "existing-session" }));' : ''}
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fresh-session" }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
}
`, "utf8");
    await fs.chmod(commandPath, 0o755);
    try {
      const result = await execute({
        runId: `resume-stop-${started}`,
        agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: "existing-session", sessionParams: null, sessionDisplayId: "existing-session", taskKey: null },
        config: { engine: "cli", command: commandPath, cwd: root, promptTemplate: "Test resume." },
        context: {}, onLog: async () => {},
      });
      expect((await fs.readFile(attemptsPath, "utf8")).trim().split("\n")).toHaveLength(started ? 1 : 2);
      expect(result.sessionId).toBe(started ? "existing-session" : "fresh-session");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies mid-turn harness crashes as retryable transient upstream errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-harness-crash-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    // Faithful to the observed MCP transport crash: the protocol stream starts,
    // then the process dies with only a harness tracing line on stderr — no
    // protocol-terminal event (error / turn.failed / turn.completed).
    const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-crash-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Starting the task." } }));
console.error("2026-07-23T22:58:56.007042Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some(\\"text/plain\\"))");
process.exit(1);
`;
    await fs.writeFile(commandPath, script, "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-harness-crash",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("codex_harness_crash");
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.errorMessage).toContain("Transport channel closed");
      expect(result.sessionId).toBe("thread-crash-1");
      expect(result.clearSession).toBe(false);
      expect((result.resultJson as Record<string, unknown>).errorFamily).toBe("transient_upstream");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists retry-not-before metadata for codex provider quota failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-usage-limit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(
      commandPath,
      "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 22, 22, 29, 0));

    try {
      const result = await execute({
        runId: "run-usage-limit",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: "codex-session-usage-limit",
          sessionParams: {
            sessionId: "codex-session-usage-limit",
            cwd: workspace,
          },
          sessionDisplayId: "codex-session-usage-limit",
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          model: "gpt-5.3-codex-spark",
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("provider_quota");
      expect(result.errorFamily).toBe("provider_quota");
      const expectedRetryNotBefore = new Date(2026, 3, 22, 23, 31, 0, 0).toISOString();
      expect(result.retryNotBefore).toBe(expectedRetryNotBefore);
      expect(result.resultJson?.retryNotBefore).toBe(expectedRetryNotBefore);
      expect(result.resultJson?.providerQuotaRetryNotBefore).toBe(expectedRetryNotBefore);
      expect(new Date(String(result.resultJson?.transientRetryNotBefore)).getTime()).toBe(
        new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
      );
    } finally {
      vi.useRealTimers();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies Codex refresh-token auth failures without credential telemetry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-refresh-token-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(commandPath, "OAuth failed: refresh_token_reused");

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-refresh-token-reused",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("refresh_token_reused");
      expect(result.errorFamily).toBe("refresh_token_reused");
      expect(result.resultJson?.errorFamily).toBe("refresh_token_reused");
      expect(result.resultJson).not.toHaveProperty("codexCredentialTelemetry");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses safer invocation settings and a fresh-session handoff for codex transient fallback retries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-fallback-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    let commandNotes: string[] = [];
    try {
      const result = await execute({
        runId: "run-fallback",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: {
            sessionId: "codex-session-stale",
            cwd: workspace,
          },
          sessionDisplayId: "codex-session-stale",
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          fastMode: true,
          model: "gpt-5.4",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          codexTransientFallbackMode: "fresh_session_safer_invocation",
          paperclipContinuationSummary: {
            key: "continuation-summary",
            title: "Continuation Summary",
            body: "Issue continuation summary for the next fresh session.",
            updatedAt: "2026-04-21T01:00:00.000Z",
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(expect.arrayContaining(["exec", "--json", "-"]));
      expect(capture.argv).not.toContain("resume");
      expect(capture.argv).not.toContain('service_tier="fast"');
      expect(capture.argv).not.toContain("features.fast_mode=true");
      expect(capture.prompt).toContain("Paperclip session handoff:");
      expect(capture.prompt).toContain("Issue continuation summary for the next fresh session.");
      expect(commandNotes).toContain("Codex transient fallback requested safer invocation settings for this retry.");
      expect(commandNotes).toContain("Codex transient fallback forced a fresh session with a continuation handoff.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("renders execution-stage wake instructions for reviewer and executor roles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-stage-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-stage-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "execution_review_requested",
          paperclipWake: {
            reason: "execution_review_requested",
            issue: {
              id: "issue-1",
              identifier: "PAP-1207",
              title: "implement the plan of PAP-1200",
              status: "in_review",
              priority: "medium",
            },
            executionStage: {
              wakeRole: "reviewer",
              stageId: "stage-1",
              stageType: "review",
              currentParticipant: { type: "agent", agentId: "qa-agent" },
              returnAssignee: { type: "agent", agentId: "coder-agent" },
              lastDecisionOutcome: null,
              allowedActions: ["approve", "request_changes"],
            },
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: {
              requestedCount: 0,
              includedCount: 0,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt).toContain("execution wake role: reviewer");
      expect(capture.prompt).toContain("You are waking as the active reviewer for this issue.");
      expect(capture.prompt).toContain("Do not execute the task itself or continue executor work.");
      expect(capture.prompt).toContain("allowed actions: approve, request_changes");

      const executorCapturePath = path.join(root, "capture-executor.json");
      const executorResult = await execute({
        runId: "run-stage-wake-executor",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: executorCapturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "execution_changes_requested",
          paperclipWake: {
            reason: "execution_changes_requested",
            issue: {
              id: "issue-1",
              identifier: "PAP-1207",
              title: "implement the plan of PAP-1200",
              status: "in_progress",
              priority: "medium",
            },
            executionStage: {
              wakeRole: "executor",
              stageId: "stage-1",
              stageType: "review",
              currentParticipant: { type: "agent", agentId: "qa-agent" },
              returnAssignee: { type: "agent", agentId: "coder-agent" },
              lastDecisionOutcome: "changes_requested",
              allowedActions: ["address_changes", "resubmit"],
            },
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: {
              requestedCount: 0,
              includedCount: 0,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(executorResult.exitCode).toBe(0);
      const executorCapture = JSON.parse(await fs.readFile(executorCapturePath, "utf8")) as CapturePayload;
      expect(executorCapture.prompt).toContain("execution wake role: executor");
      expect(executorCapture.prompt).toContain("You are waking because changes were requested in the execution workflow.");
      expect(executorCapture.prompt).toContain("allowed actions: address_changes, resubmit");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("renders an issue-scoped wake prompt even when the wake has no comments yet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-issue-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-issue-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_assigned",
          paperclipWake: {
            reason: "issue_assigned",
            issue: {
              id: "issue-1",
              identifier: "PAP-1201",
              title: "Fix gallery opening for inline images",
              status: "in_progress",
              priority: "medium",
            },
            checkedOutByHarness: true,
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: {
              requestedCount: 0,
              includedCount: 0,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).not.toContain("PAPERCLIP_WAKE_PAYLOAD_JSON");
      expect(capture.paperclipWakePayloadJson).toBeNull();
      expect(capture.prompt).toContain("## Paperclip Wake Payload");
      expect(capture.prompt).toContain("Do not switch to another issue until you have handled this wake.");
      expect(capture.prompt).toContain("- issue: PAP-1201 Fix gallery opening for inline images");
      expect(capture.prompt).not.toContain("- pending comments:");
      expect(capture.prompt).not.toContain("acknowledge the latest comment");
      expect(capture.prompt).not.toContain("Execution contract:");
      expect(capture.prompt).toContain("- issue status: in_progress");
      expect(capture.prompt).toContain("- checkout: already claimed by the harness for this run");
      expect(capture.prompt).toContain("The harness already checked out this issue for the current run.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([{ conversationMode: false, resumedSession: true }, { conversationMode: true, resumedSession: true }, { conversationMode: true, resumedSession: false }])("retains current task policy (conversation=$conversationMode, resumed=$resumedSession)", async ({ conversationMode, resumedSession }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-resume-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "You are managed instructions.\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    const policy = conversationMode
      ? buildPaperclipTaskMarkdown({
          issue: { id: "issue-1", identifier: null, title: "Chat", workMode: "planning", conversationAgentId: "agent-1" },
          interaction: { kind: "request_confirmation", status: "rejected" },
          planReview: { status: "rejected", reason: "Revise the final note." },
          includeDescription: false,
        })
      : "Current ordinary task policy";
    let invocationPrompt = "";
    let invocationNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    try {
      const result = await execute({
        runId: "run-resume-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: {
            sessionId: resumedSession ? "codex-session-1" : null,
            cwd: workspace,
          },
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: conversationMode ? undefined : "Follow the paperclip heartbeat.",
        },
        context: {
          conversationMode,
          paperclipTaskMarkdown: `Full description that must not replay\n${policy}`,
          paperclipTaskMarkdownCompact: policy,
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          paperclipWake: {
            reason: "issue_commented",
            issue: {
              id: "issue-1",
              identifier: "PAP-874",
              title: "chat-speed issues",
              status: "in_progress",
              priority: "medium",
            },
            commentIds: ["comment-2"],
            latestCommentId: "comment-2",
            comments: [
              {
                id: "comment-2",
                issueId: "issue-1",
                body: "Second comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:10.000Z",
                author: { type: "user", id: "user-1" },
              },
            ],
            commentWindow: {
              requestedCount: 1,
              includedCount: 1,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
          invocationNotes = meta.commandNotes ?? [];
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      if (resumedSession) expect(capture.argv).toEqual(expect.arrayContaining(["resume", "codex-session-1", "-"]));
      else expect(capture.argv).not.toContain("resume");
      expect(capture.prompt).toContain(resumedSession ? "## Paperclip Resume Delta" : "## Paperclip Wake Payload");
      expect(capture.prompt).toContain("Do not switch to another issue until you have handled this wake.");
      expect(capture.prompt).toContain("Second comment");
      expect(capture.prompt).toContain(policy);
      expect(invocationPrompt).toContain(policy);
      if (resumedSession) expect(capture.prompt).not.toContain("Full description that must not replay");
      else expect(capture.prompt).toContain("Full description that must not replay");
      expect(promptMetrics.taskContextChars).toBe(resumedSession ? policy!.length : `Full description that must not replay\n${policy}`.length);
      if (conversationMode) {
        expect(invocationPrompt).toContain(AGENT_CHAT_DIRECTIVE);
        expect(invocationPrompt).toContain("baseRevisionId set to that latestRevisionId");
        expect(capture.prompt).not.toContain("Execution contract:");
        expect(capture.prompt).not.toContain("Use child issues");
      }
      expect(capture.prompt).not.toContain("Execution contract:");
      expect(capture.prompt).not.toContain("Follow the paperclip heartbeat.");
      if (resumedSession) {
        expect(capture.prompt).not.toContain("You are managed instructions.");
        expect(invocationPrompt).toContain("## Paperclip Resume Delta");
        expect(invocationNotes).toContain("Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.");
        expect(promptMetrics.instructionsChars).toBe(0);
        expect(promptMetrics.heartbeatPromptChars).toBe(0);
      } else {
        expect(capture.prompt).toContain("You are managed instructions.");
        expect(promptMetrics.heartbeatPromptChars).toBeGreaterThan(0);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("uses a worktree-isolated CODEX_HOME and mounts the operational skill by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const isolatedCodexHome = path.join(
      paperclipHome,
      "instances",
      "worktree-1",
      "companies",
      "company-1",
      "codex-home",
    );
    const homeSkill = path.join(isolatedCodexHome, "skills", "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "worktree-1";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(isolatedCodexHome);
      expect(capture.argv).toEqual(expect.arrayContaining(["exec", "--json", "-"]));
      expect(capture.prompt).toContain("Follow the paperclip heartbeat.");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );

      const isolatedAuth = path.join(isolatedCodexHome, "auth.json");
      const isolatedConfig = path.join(isolatedCodexHome, "config.toml");

      expect((await fs.lstat(isolatedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(isolatedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(isolatedConfig)).isFile()).toBe(true);
      expect(await fs.readFile(isolatedConfig, "utf8")).toBe('model = "codex-mini-latest"\n');
      expect((await fs.lstat(homeSkill)).isSymbolicLink()).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using worktree-isolated Codex home"),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining('Injected Codex skill "paperclip"'),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates connector skills by agent and revision without changing the selected model identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-connector-codex-"));
    const workspace = path.join(root, "workspace");
    const command = path.join(root, "codex");
    const capture = path.join(root, "capture.json");
    const sourceHome = path.join(root, "selected-account");
    const skillSource = path.join(root, "skill-v1");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(skillSource, { recursive: true });
    const selectedAuth = JSON.stringify({ tokens: { account_id: "original-selected-account", access_token: "test-subscription-token" } });
    await fs.writeFile(path.join(sourceHome, "auth.json"), selectedAuth);
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# AgentMail\nAssigned inbox one.");
    await writeFakeCodexCommand(command);
    const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "connectors";
    process.env.CODEX_HOME = sourceHome;
    const invoke = async (agentId: string, digest: string | null, source = skillSource, connectorSkillInstructions = "") => {
      const config = {
        engine: "cli", command, cwd: workspace,
        env: { CODEX_HOME: sourceHome, PAPERCLIP_TEST_CAPTURE_PATH: capture },
        paperclipConnectorSkillDigest: digest,
        paperclipSkillSync: { desiredSkills: digest ? ["paperclipai/paperclip/agentmail"] : [] },
        paperclipRuntimeSkills: digest ? [{ key: "paperclipai/paperclip/agentmail", runtimeName: "agentmail", source }] : [],
      };
      const result = await execute({ runId: `run-${agentId}-${digest?.slice(0, 1) ?? "none"}`,
        agent: { id: agentId, companyId: "company-1", name: "Email agent", adapterType: "codex_local", adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: { paperclipWake: { connectorSkillInstructions } }, authToken: "test-token", onLog: async () => {},
      });
      expect(result.errorMessage).toBeNull();
      expect(result.exitCode).toBe(0);
      return JSON.parse(await fs.readFile(capture, "utf8")) as CapturePayload;
    };
    try {
      const first = await invoke("agent-1", "a".repeat(64));
      expect(first.codexHome).toContain("connector-runtimes/agent-1/");
      expect(await fs.realpath(path.join(first.codexHome!, "auth.json"))).toBe(await fs.realpath(path.join(sourceHome, "auth.json")));
      expect(await fs.readFile(path.join(first.codexHome!, "skills/agentmail/SKILL.md"), "utf8")).toContain("inbox one");
      await expect(fs.stat(path.join(sourceHome, "skills/agentmail"))).rejects.toMatchObject({ code: "ENOENT" });
      const other = await invoke("agent-2", "a".repeat(64));
      expect(other.codexHome).not.toBe(first.codexHome);
      const nextSource = path.join(root, "skill-v2");
      await fs.mkdir(nextSource);
      await fs.writeFile(path.join(nextSource, "SKILL.md"), "# AgentMail\nAssigned inbox two.");
      const next = await invoke("agent-1", "b".repeat(64), nextSource);
      expect(next.codexHome).not.toBe(first.codexHome);
      expect(await fs.readFile(path.join(next.codexHome!, "skills/agentmail/SKILL.md"), "utf8")).toContain("inbox two");
      const inline = await invoke("agent-1", null, skillSource, "# AgentMail\nAssigned inbox inline@example.test");
      expect(inline.prompt).toContain("Assigned inbox inline@example.test");
      await expect(fs.stat(path.join(sourceHome, "skills/agentmail"))).rejects.toMatchObject({ code: "ENOENT" });
      const removed = await invoke("agent-1", null);
      expect(removed.prompt).not.toContain("inline@example.test");
      expect(removed.codexHome).not.toBe(sourceHome);
      expect(removed.codexHome).toContain("skill-runtimes/agent-1/");
      await expect(fs.stat(path.join(removed.codexHome!, "skills/agentmail"))).rejects.toMatchObject({ code: "ENOENT" });
      // Remote credential copy-back leaves a regular file. A later authorized
      // account switch must not reuse that previous account's generated home.
      await fs.unlink(path.join(first.codexHome!, "auth.json"));
      await fs.writeFile(path.join(first.codexHome!, "auth.json"), selectedAuth);
      const nextAccount = JSON.parse(selectedAuth);
      nextAccount.tokens.account_id = "new-selected-account";
      await fs.writeFile(path.join(sourceHome, "auth.json"), JSON.stringify(nextAccount));
      const switched = await invoke("agent-1", "a".repeat(64));
      expect(switched.codexHome).not.toBe(first.codexHome);
      expect(JSON.parse(await fs.readFile(path.join(switched.codexHome!, "auth.json"), "utf8")).tokens.account_id).toBe("new-selected-account");
      nextAccount.tokens.access_token = "refreshed-same-account-token";
      await fs.writeFile(path.join(sourceHome, "auth.json"), JSON.stringify(nextAccount));
      expect((await invoke("agent-1", "a".repeat(64))).codexHome).toBe(switched.codexHome);
      expect(await fs.readFile(path.join(first.codexHome!, "auth.json"), "utf8")).toBe(selectedAuth);

    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("isolates private skills and keeps custom routing with an explicit credential home: %s", async (explicitHome) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-private-codex-"));
    const workspace = path.join(root, "workspace");
    const command = path.join(root, "codex");
    const capture = path.join(root, "capture.json");
    const sourceHome = path.join(root, "selected-account");
    const skillSource = path.join(root, "skill-v1");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(sourceHome, "auth.json"), fakeCodexAuthJson);
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# AgentMail\nAssigned inbox one.");
    await writeFakeCodexCommand(command);
    const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "connectors";
    process.env.CODEX_HOME = sourceHome;
    const invoke = async (agentId: string, digest: string | null, source = skillSource, connectorSkillInstructions = "") => {
      const config = {
        engine: "cli", command, cwd: workspace,
        env: { ...(explicitHome ? { CODEX_HOME: sourceHome } : {}), PAPERCLIP_TEST_CAPTURE_PATH: capture,
          PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: { test_gateway: {
            name: "Fixture gateway", base_url: "https://gateway.example/v1", wire_api: "responses",
          } }, model_provider: "test_gateway" }),
        },

        paperclipSkillSync: { desiredSkills: digest ? ["paperclipai/paperclip/agentmail"] : [] },
        paperclipRuntimeSkills: digest ? [{ key: "paperclipai/paperclip/agentmail", runtimeName: "agentmail", source }] : [],
      };
      const result = await execute({ runId: `run-${agentId}-${digest?.slice(0, 1) ?? "none"}`,
        agent: { id: agentId, companyId: "company-1", name: "Email agent", adapterType: "codex_local", adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: { paperclipWake: { connectorSkillInstructions } }, authToken: "test-token", onLog: async () => {},
      });
      expect(result.errorMessage).toBeNull();
      expect(result.exitCode).toBe(0);
      return JSON.parse(await fs.readFile(capture, "utf8")) as CapturePayload;
    };
    try {
      const first = await invoke("agent-1", "a".repeat(64));
      expect(first.codexHome).toContain("skill-runtimes/agent-1/");
      expect(first.codexConfigContents).toContain('model_provider = "test_gateway"');
      expect(first.codexConfigContents).toContain('base_url = "https://gateway.example/v1"');
      expect(await fs.realpath(path.join(first.codexHome!, "auth.json"))).toBe(await fs.realpath(path.join(sourceHome, "auth.json")));
      expect(await fs.readFile(path.join(first.codexHome!, "skills/agentmail/SKILL.md"), "utf8")).toContain("inbox one");
      await expect(fs.stat(path.join(sourceHome, "skills/agentmail"))).rejects.toMatchObject({ code: "ENOENT" });
      const unchanged = await invoke("agent-1", "a".repeat(64));
      expect(unchanged.codexHome).toBe(first.codexHome);
      const other = await invoke("agent-2", "a".repeat(64));
      expect(other.codexHome).not.toBe(first.codexHome);
      const nextSource = path.join(root, "skill-v2");
      await fs.mkdir(nextSource);
      await fs.writeFile(path.join(nextSource, "SKILL.md"), "# AgentMail\nAssigned inbox two.");
      const next = await invoke("agent-1", "b".repeat(64), nextSource);
      expect(next.codexHome).not.toBe(first.codexHome);
      expect(await fs.readFile(path.join(next.codexHome!, "skills/agentmail/SKILL.md"), "utf8")).toContain("inbox two");
      const inline = await invoke("agent-1", null, skillSource, "# AgentMail\nAssigned inbox inline@example.test");
      expect(inline.prompt).toContain("Assigned inbox inline@example.test");
      await expect(fs.stat(path.join(sourceHome, "skills/agentmail"))).rejects.toMatchObject({ code: "ENOENT" });
      const removed = await invoke("agent-1", null);
      expect(removed.prompt).not.toContain("inline@example.test");
      // The old saved files still exist; exclusion is enforced by the launch home.
      expect(await fs.readFile(path.join(first.codexHome!, "skills/agentmail/SKILL.md"), "utf8")).toContain("inbox one");
      expect(removed.codexHome).not.toBe(first.codexHome);
      expect(removed.codexConfigContents).toContain('model_provider = "test_gateway"');
      expect(await fs.realpath(path.join(removed.codexHome!, "auth.json"))).toBe(await fs.realpath(path.join(sourceHome, "auth.json")));
      expect(removed.codexHome).not.toBe(sourceHome);
      expect(removed.codexHome).toContain("skill-runtimes/agent-1/");
      await expect(fs.stat(path.join(removed.codexHome!, "skills/agentmail"))).rejects.toMatchObject({ code: "ENOENT" });
      if (!explicitHome) {
        // A promoted company login can differ from the host's default account.
        // Digest and seeding must use that same effective credential source.
        const companyHome = path.resolve(first.codexHome!, "../../..");
        await fs.unlink(path.join(companyHome, "auth.json"));
        const originalAccount = JSON.stringify({ tokens: { account_id: "company-account-one", access_token: "test-token-one" } });
        await fs.writeFile(path.join(companyHome, "auth.json"), originalAccount);
        const companyRun = await invoke("agent-1", "a".repeat(64));
        expect(JSON.parse(await fs.readFile(path.join(companyRun.codexHome!, "auth.json"), "utf8")).tokens.account_id).toBe("company-account-one");
        await fs.unlink(path.join(companyRun.codexHome!, "auth.json"));
        await fs.writeFile(path.join(companyRun.codexHome!, "auth.json"), originalAccount);
        await fs.writeFile(path.join(companyHome, "auth.json"), JSON.stringify({ tokens: { account_id: "company-account-two", access_token: "test-token-two" } }));
        const companyNext = await invoke("agent-1", "a".repeat(64));
        expect(companyNext.codexHome).not.toBe(companyRun.codexHome);
        expect(JSON.parse(await fs.readFile(path.join(companyNext.codexHome!, "auth.json"), "utf8")).tokens.account_id).toBe("company-account-two");
        expect(await fs.readFile(path.join(sourceHome, "auth.json"), "utf8")).toBe(fakeCodexAuthJson);
      } else {
        await fs.writeFile(path.join(sourceHome, "config.toml"), '[mcp_servers.changed]\ncommand = "new-selected-server"\n');
        const settingsChanged = await invoke("agent-1", "a".repeat(64));
        expect(settingsChanged.codexHome).not.toBe(first.codexHome);
        expect(settingsChanged.codexConfigContents).toContain('command = "new-selected-server"');
        expect(settingsChanged.codexConfigContents).toContain('model_provider = "test_gateway"');
        await fs.unlink(path.join(sourceHome, "config.toml"));
        const settingsRemoved = await invoke("agent-1", "a".repeat(64));
        expect(settingsRemoved.codexConfigContents).not.toContain('new-selected-server');
      }

    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // RAI-2802: a managed AI connection points CODEX_HOME at a fresh server-created
  // credential home (`<tmpdir>/paperclip-ai-*/provider`) on every run. That path is
  // not an identity; hashing it into the runtime digest made every run a new home.
  it("reuses one generated home across runs whose managed credential home path and tokens change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reuse-codex-"));
    const workspace = path.join(root, "workspace");
    const command = path.join(root, "codex");
    const capture = path.join(root, "capture.json");
    const skillSource = path.join(root, "skill-v1");
    const tempHomes: string[] = [];
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# AgentMail\nAssigned inbox one.");
    await writeFakeCodexCommand(command);
    const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "reuse";
    delete process.env.CODEX_HOME;
    // Mirrors ai-connection-runtime: mkdtemp(<tmpdir>/paperclip-ai-<company>-<grant>-) + /provider.
    const serverCredentialHome = async (accountId: string, token: string, parent?: string) => {
      const home = await fs.mkdtemp(path.join(parent ?? await fs.realpath(os.tmpdir()), "paperclip-ai-company-1-grant-1-"));
      tempHomes.push(home);
      const provider = path.join(home, "provider");
      await fs.mkdir(provider, { mode: 0o700 });
      await fs.writeFile(path.join(provider, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      await fs.writeFile(path.join(provider, "auth.json"), JSON.stringify({ tokens: { account_id: accountId, access_token: token } }));
      return provider;
    };
    const invoke = async (provider: string, sessionIdentity: string | null, opts: { agentId?: string; digestSkills?: boolean } = {}) => {
      const config = {
        engine: "cli", command, cwd: workspace,
        env: { CODEX_HOME: provider, PAPERCLIP_TEST_CAPTURE_PATH: capture },
        ...(sessionIdentity ? { managedAiConnection: { sessionIdentity } } : {}),
        paperclipSkillSync: { desiredSkills: opts.digestSkills === false ? [] : ["paperclipai/paperclip/agentmail"] },
        paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/agentmail", runtimeName: "agentmail", source: skillSource }],
      };
      const agentId = opts.agentId ?? "agent-1";
      const result = await execute({ runId: `run-${agentId}-${Math.random()}`,
        agent: { id: agentId, companyId: "company-1", name: "QA", adapterType: "codex_local", adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: {}, authToken: "test-token", onLog: async () => {},
      });
      expect(result.errorMessage).toBeNull();
      expect(result.exitCode).toBe(0);
      return JSON.parse(await fs.readFile(capture, "utf8")) as CapturePayload;
    };
    const homesFor = async (agentId: string) =>
      (await fs.readdir(path.join(root, "paperclip/instances/reuse/companies/company-1/codex-home/skill-runtimes", agentId)).catch(() => [])).length;
    try {
      const first = await invoke(await serverCredentialHome("acct-a", "token-1"), "grant-1:user-1:secret-1:1");
      expect(first.codexHome).toContain("skill-runtimes/agent-1/");
      // Five consecutive runs, each with a brand-new credential home path and a refreshed token.
      for (let run = 2; run <= 5; run += 1) {
        const next = await invoke(await serverCredentialHome("acct-a", `token-${run}`), "grant-1:user-1:secret-1:1");
        expect(next.codexHome).toBe(first.codexHome);
      }
      expect(await homesFor("agent-1")).toBe(1);
      // Run end: the lease is released and Codex's plugin marketplace clone is dropped,
      // while session state stays. (Codex itself re-creates `.tmp/plugins` on demand.)
      await fs.mkdir(path.join(first.codexHome!, ".tmp/plugins"), { recursive: true });
      await fs.mkdir(path.join(first.codexHome!, "sessions/2026/11"), { recursive: true });
      await fs.writeFile(path.join(first.codexHome!, "sessions/2026/11/rollout.jsonl"), "{}\n");
      const afterCache = await invoke(await serverCredentialHome("acct-a", "token-5b"), "grant-1:user-1:secret-1:1");
      expect(afterCache.codexHome).toBe(first.codexHome);
      await expect(fs.stat(path.join(first.codexHome!, ".tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(path.join(first.codexHome!, ".paperclip-leases"))).toEqual([]);
      expect(await fs.readFile(path.join(first.codexHome!, "sessions/2026/11/rollout.jsonl"), "utf8")).toBe("{}\n");
      // The reused home follows the newest credential, not the first run's deleted source.
      expect(JSON.parse(await fs.readFile(path.join(first.codexHome!, "auth.json"), "utf8")).tokens.access_token).toBe("token-5b");

      // A different connection session (another account/user/epoch) is isolated.
      const otherSession = await invoke(await serverCredentialHome("acct-b", "token-b"), "grant-1:user-1:secret-2:1");
      expect(otherSession.codexHome).not.toBe(first.codexHome);
      const reconnected = await invoke(await serverCredentialHome("acct-a", "token-6"), "grant-1:user-1:secret-1:2");
      expect(reconnected.codexHome).not.toBe(first.codexHome);
      // Same session identity but the stored account changed underneath: never share.
      const swapped = await invoke(await serverCredentialHome("acct-c", "token-c"), "grant-1:user-1:secret-1:1");
      expect(swapped.codexHome).not.toBe(first.codexHome);
      // Removing a skill authorization selects a different home.
      const revoked = await invoke(await serverCredentialHome("acct-a", "token-7"), "grant-1:user-1:secret-1:1", { digestSkills: false });
      expect(revoked.codexHome).not.toBe(first.codexHome);
      // Another agent never shares.
      const otherAgent = await invoke(await serverCredentialHome("acct-a", "token-8"), "grant-1:user-1:secret-1:1", { agentId: "agent-2" });
      expect(otherAgent.codexHome).not.toBe(first.codexHome);

      // Safe degradation: no session identity, or a credential home that is not the
      // server-created `paperclip-ai-*/provider` directory, keeps the path in the digest.
      const noIdentityA = await invoke(await serverCredentialHome("acct-a", "token-9"), null);
      const noIdentityB = await invoke(await serverCredentialHome("acct-a", "token-10"), null);
      expect(noIdentityA.codexHome).not.toBe(noIdentityB.codexHome);
      const foreign = path.join(root, "foreign");
      await fs.mkdir(foreign);
      const foreignA = await invoke(await serverCredentialHome("acct-a", "token-11", foreign), "grant-1:user-1:secret-1:1");
      const foreignB = await invoke(await serverCredentialHome("acct-a", "token-12", foreign), "grant-1:user-1:secret-1:1");
      expect(foreignA.codexHome).not.toBe(foreignB.codexHome);
      expect(foreignA.codexHome).not.toBe(first.codexHome);
    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await Promise.all(tempHomes.map((home) => fs.rm(home, { recursive: true, force: true })));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // RAI-2819: a run that cannot be leased must not use a shared generated home, because
  // recycling only honours leases and would see the home as idle.
  it("refuses to run in a generated home it cannot lease, and leaves the home untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-lease-fail-codex-"));
    const workspace = path.join(root, "workspace");
    const command = path.join(root, "codex");
    const capture = path.join(root, "capture.json");
    const skillSource = path.join(root, "skill-v1");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# AgentMail\nAssigned inbox one.");
    await writeFakeCodexCommand(command);
    const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "lease-fail";
    delete process.env.CODEX_HOME;
    const credentialHomes: string[] = [];
    const invoke = async () => {
      const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paperclip-ai-company-1-grant-1-"));
      credentialHomes.push(parent);
      const provider = path.join(parent, "provider");
      await fs.mkdir(provider, { mode: 0o700 });
      await fs.writeFile(path.join(provider, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      await fs.writeFile(path.join(provider, "auth.json"), JSON.stringify({ tokens: { account_id: "acct-a", access_token: "t" } }));
      const config = {
        engine: "cli", command, cwd: workspace,
        env: { CODEX_HOME: provider, PAPERCLIP_TEST_CAPTURE_PATH: capture },
        managedAiConnection: { sessionIdentity: "grant-1:user-1:secret-1:1" },
        paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/agentmail"] },
        paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/agentmail", runtimeName: "agentmail", source: skillSource }],
      };
      return execute({ runId: `run-${Math.random()}`,
        agent: { id: "agent-1", companyId: "company-1", name: "QA", adapterType: "codex_local", adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: {}, authToken: "test-token", onLog: async () => {},
      });
    };
    try {
      const ok = await invoke();
      expect(ok.exitCode).toBe(0);
      const home = JSON.parse(await fs.readFile(capture, "utf8")).codexHome as string;
      await fs.mkdir(path.join(home, "sessions"), { recursive: true });
      await fs.writeFile(path.join(home, "sessions/rollout.jsonl"), "{}\n");
      // The lease directory can no longer be created in this home.
      await fs.rm(path.join(home, ".paperclip-leases"), { recursive: true, force: true });
      await fs.writeFile(path.join(home, ".paperclip-leases"), "blocked");
      await fs.rm(capture, { force: true });

      const refused = await invoke();
      expect(refused.errorCode).toBe("codex_home_lease_unavailable");
      expect(refused.exitCode).toBeNull();
      await expect(fs.stat(capture)).rejects.toMatchObject({ code: "ENOENT" }); // codex was never launched
      expect(await fs.readFile(path.join(home, "sessions/rollout.jsonl"), "utf8")).toBe("{}\n");
    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await Promise.all(credentialHomes.map((dir) => fs.rm(dir, { recursive: true, force: true })));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // RAI-2819: setup between lease acquisition and the main try (credential check, runtime
  // config) can throw; the lease must not outlive that, or the home is pinned until the
  // server process exits.
  it("releases the home lease when setup throws before the run starts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-lease-setup-fail-codex-"));
    const workspace = path.join(root, "workspace");
    const command = path.join(root, "codex");
    const skillSource = path.join(root, "skill-v1");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# AgentMail\nAssigned inbox one.");
    await writeFakeCodexCommand(command);
    const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME", "OPENAI_API_KEY"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "lease-setup-fail";
    delete process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;
    const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paperclip-ai-company-1-grant-1-"));
    const provider = path.join(parent, "provider");
    await fs.mkdir(provider, { mode: 0o700 });
    // No auth.json: assertCodexCredentialsLaunchable throws after the lease is taken.
    await fs.writeFile(path.join(provider, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const config = {
      engine: "cli", command, cwd: workspace,
      env: { CODEX_HOME: provider },
      managedAiConnection: { sessionIdentity: "grant-1:user-1:secret-1:1" },
      paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/agentmail"] },
      paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/agentmail", runtimeName: "agentmail", source: skillSource }],
    };
    try {
      await expect(execute({ runId: "run-setup-fail",
        agent: { id: "agent-1", companyId: "company-1", name: "QA", adapterType: "codex_local", adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: {}, authToken: "test-token", onLog: async () => {},
      })).rejects.toThrow(/no Codex credentials provisioned/);
      const agentRoot = path.join(process.env.PAPERCLIP_HOME, "instances/lease-setup-fail/companies/company-1/codex-home/skill-runtimes/agent-1");
      const homes = (await fs.readdir(agentRoot)).filter((name) => /^[a-f0-9]{64}$/.test(name));
      // The home was created (so the lease really was taken), and holds no lease now.
      expect(homes).toHaveLength(1);
      const leases = (await fs.readdir(path.join(agentRoot, homes[0], ".paperclip-leases")).catch(() => []))
        .filter((name) => name.endsWith(".json"));
      expect(leases).toEqual([]);
    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await fs.rm(parent, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects an explicit CODEX_HOME config override even in worktree mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-explicit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const explicitCodexHome = path.join(root, "explicit-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "worktree-1";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            CODEX_HOME: explicitCodexHome,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
          paperclipSkillSync: {
            desiredSkills: ["paperclip"],
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(explicitCodexHome);
      expect((await fs.lstat(path.join(explicitCodexHome, "skills", "paperclip"))).isSymbolicLink()).toBe(true);
      await expect(fs.lstat(path.join(paperclipHome, "instances", "worktree-1", "codex-home"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
