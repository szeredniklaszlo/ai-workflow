import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { WORKSPACE_ROOT_DIR } from "./repo-workspace.js";

const DEFAULT_DOCKER_SANDBOX_IMAGE = "ai-workflow-sandbox:latest";
const SNAPSHOT_IMAGE_REPO = "aiw-snapshot";
const DEFAULT_TIMEOUT_MS = 3_600_000;

export interface DockerCommandResult {
  cmdId: string;
  exitCode: number | null;
  stdout(opts?: { signal?: AbortSignal }): Promise<string>;
  stderr(opts?: { signal?: AbortSignal }): Promise<string>;
}

export interface DockerRunCommandOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  detached?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export type DockerSandboxSource =
  | {
  type: "git";
  url: string;
  username?: string;
  password?: string;
  revision?: string;
}
  | {
  type: "snapshot";
  snapshotId: string;
};

export interface DockerSandboxCreateOptions {
  source?: DockerSandboxSource;
  runtime?: string;
  timeout?: number;
  signal?: AbortSignal;
  token?: string;
  teamId?: string;
  projectId?: string;
}

export interface DockerSandboxGetOptions {
  sandboxId: string;
  signal?: AbortSignal;
  token?: string;
  teamId?: string;
  projectId?: string;
}

interface RawExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

function sandboxImage(): string {
  return process.env.DOCKER_SANDBOX_IMAGE?.trim() || DEFAULT_DOCKER_SANDBOX_IMAGE;
}

function snapshotImageTag(snapshotId: string): string {
  return `${SNAPSHOT_IMAGE_REPO}:${snapshotId}`;
}

function createHttpError(status: number, message: string): Error & {
  status: number;
  statusCode: number;
  response: { status: number };
  json: { error: { message: string }; message: string };
} {
  const error = new Error(message) as Error & {
    status: number;
    statusCode: number;
    response: { status: number };
    json: { error: { message: string }; message: string };
  };
  error.status = status;
  error.statusCode = status;
  error.response = { status };
  error.json = { error: { message }, message };
  return error;
}

function execDocker(
  args: string[],
  options: { input?: Buffer; signal?: AbortSignal } = {},
): Promise<RawExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("Docker command aborted"));
      return;
    }
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const onAbort = () => {
      child.kill("SIGKILL");
      reject(options.signal?.reason ?? new Error("Docker command aborted"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (err) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function buildBasicAuthHeader(username?: string, password?: string): string[] {
  if (!password) return [];
  const user = username ?? "x-access-token";
  const credentials = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  return ["-c", `http.extraHeader=AUTHORIZATION: Basic ${credentials}`];
}

export class Sandbox {
  readonly sandboxId: string;
  status: "running" | "stopped" | "failed" | "aborted";

  constructor(
    sandboxId: string,
    status: "running" | "stopped" | "failed" | "aborted" = "running",
  ) {
    this.sandboxId = sandboxId;
    this.status = status;
  }

  static async create(options: DockerSandboxCreateOptions = {}): Promise<Sandbox> {
    const sandboxId = `sbx_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const sleepSeconds = Math.max(60, Math.ceil(timeoutMs / 1_000));
    const now = Date.now();
    const expiresAt = now + timeoutMs;

    let image = sandboxImage();
    if (options.source?.type === "snapshot") {
      const snapId = options.source.snapshotId;
      const snapTag = snapshotImageTag(snapId);
      const inspect = await execDocker(
        [
          "image",
          "inspect",
          "--format",
          "{{index .Config.Labels \"aiw.expiresAt\"}}",
          snapTag,
        ],
        { signal: options.signal },
      );
      if (inspect.exitCode !== 0) {
        throw createHttpError(404, `Snapshot ${snapId} not found`);
      }
      const snapExpiresAt = Number(inspect.stdout.toString("utf8").trim());
      if (Number.isFinite(snapExpiresAt) && snapExpiresAt > 0 && snapExpiresAt <= Date.now()) {
        throw createHttpError(404, `Snapshot ${snapId} expired`);
      }
      image = snapTag;
    }

    const runResult = await execDocker(
      [
        "run",
        "-d",
        "--name",
        sandboxId,
        "--workdir",
        WORKSPACE_ROOT_DIR,
        "--label",
        "aiw.managed=true",
        "--label",
        `aiw.createdAt=${now}`,
        "--label",
        `aiw.expiresAt=${expiresAt}`,
        image,
        "sh",
        "-c",
        `mkdir -p ${WORKSPACE_ROOT_DIR} && exec sleep ${sleepSeconds}`,
      ],
      { signal: options.signal },
    );

    if (runResult.exitCode !== 0) {
      const detail = runResult.stderr.toString("utf8").trim() || "docker run failed";
      throw new Error(`Docker sandbox creation failed: ${detail}`);
    }

    const instance = new Sandbox(sandboxId, "running");

    if (options.source?.type === "git") {
      const { url, username, password, revision } = options.source;
      const authArgs = buildBasicAuthHeader(username, password);
      const cloneArgs = [
        ...authArgs,
        "clone",
        ...(revision ? ["--branch", revision] : []),
        url,
        WORKSPACE_ROOT_DIR,
      ];
      const cloneResult = await instance.runCommand("git", cloneArgs, {
        signal: options.signal,
      });
      if (cloneResult.exitCode !== 0) {
        const stderr = (await cloneResult.stderr()).trim();
        const stdout = (await cloneResult.stdout()).trim();
        await instance.stop({ blocking: true }).catch(() => {});
        throw createHttpError(
          400,
          stderr || stdout || `git clone failed for ${url}`,
        );
      }
    }

    return instance;
  }

  static async get(options: DockerSandboxGetOptions): Promise<Sandbox> {
    const inspect = await execDocker(
      [
        "inspect",
        "--format",
        "{{.State.Running}}|{{.State.Status}}",
        options.sandboxId,
      ],
      { signal: options.signal },
    );
    if (inspect.exitCode !== 0) {
      return new Sandbox(options.sandboxId, "stopped");
    }
    const output = inspect.stdout.toString("utf8").trim();
    const [running] = output.split("|");
    return new Sandbox(
      options.sandboxId,
      running === "true" ? "running" : "stopped",
    );
  }

  async runCommand(
    cmdOrOpts: string | DockerRunCommandOptions,
    args?: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<DockerCommandResult> {
    const normalized: DockerRunCommandOptions =
      typeof cmdOrOpts === "string"
        ? { cmd: cmdOrOpts, args: args ?? [], signal: opts?.signal }
        : cmdOrOpts;

    const cwd = normalized.cwd ?? WORKSPACE_ROOT_DIR;
    const envFlags: string[] = [];
    if (normalized.env) {
      for (const [key, value] of Object.entries(normalized.env)) {
        envFlags.push("-e", `${key}=${value}`);
      }
    }

    if (normalized.detached) {
      const cmdId = `cmd_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const pidFile = `/tmp/.aiw-cmd-${cmdId}.pid`;
      const launchScript = `nohup "$@" >/dev/null 2>&1 & echo $! > ${pidFile}`;
      const execArgs = [
        "exec",
        "-w",
        cwd,
        ...envFlags,
        this.sandboxId,
        "sh",
        "-c",
        launchScript,
        "_",
        normalized.cmd,
        ...(normalized.args ?? []),
      ];
      const launched = await execDocker(execArgs, { signal: normalized.signal });
      if (launched.exitCode !== 0) {
        const out = launched.stdout.toString("utf8");
        const err = launched.stderr.toString("utf8");
        return {
          cmdId,
          exitCode: launched.exitCode,
          stdout: async () => out,
          stderr: async () => err,
        };
      }
      return {
        cmdId,
        exitCode: null,
        stdout: async () => "",
        stderr: async () => "",
      };
    }

    const execArgs = [
      "exec",
      "-w",
      cwd,
      ...envFlags,
      this.sandboxId,
      normalized.cmd,
      ...(normalized.args ?? []),
    ];
    const result = await execDocker(execArgs, { signal: normalized.signal });
    const stdoutText = result.stdout.toString("utf8");
    const stderrText = result.stderr.toString("utf8");
    return {
      cmdId: "cmd_sync",
      exitCode: result.exitCode,
      stdout: async () => stdoutText,
      stderr: async () => stderrText,
    };
  }

  async getCommand(
    cmdId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    kill(
      signal?: string,
      killOpts?: { abortSignal?: AbortSignal },
    ): Promise<void>;
  }> {
    const sandboxId = this.sandboxId;
    const pidFile = `/tmp/.aiw-cmd-${cmdId}.pid`;
    return {
      async kill(_signal?: string, killOpts?: { abortSignal?: AbortSignal }) {
        const abortSignal = killOpts?.abortSignal ?? options?.signal;
        const script = [
          `if [ -f "${pidFile}" ]; then`,
          `  pid=$(cat "${pidFile}" 2>/dev/null || true)`,
          `  if [ -n "$pid" ]; then`,
          `    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
          `    sleep 0.2`,
          `    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true`,
          `  fi`,
          `  rm -f "${pidFile}"`,
          `fi`,
        ].join("\n");
        await execDocker(
          ["exec", sandboxId, "sh", "-c", script],
          { signal: abortSignal },
        ).catch(() => {});
      },
    };
  }

  async writeFiles(
    files: Array<{ path: string; content: Buffer | Uint8Array | string }>,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    for (const file of files) {
      const dir = posix.dirname(file.path);
      const bytes = Buffer.isBuffer(file.content)
        ? file.content
        : typeof file.content === "string"
          ? Buffer.from(file.content, "utf8")
          : Buffer.from(file.content);
      const res = await execDocker(
        [
          "exec",
          "-i",
          this.sandboxId,
          "sh",
          "-c",
          'mkdir -p "$1" && cat > "$2"',
          "_",
          dir,
          file.path,
        ],
        { input: bytes, signal: options?.signal },
      );
      if (res.exitCode !== 0) {
        const err = res.stderr.toString("utf8").trim() || "writeFiles failed";
        throw new Error(`Failed to write ${file.path} in sandbox ${this.sandboxId}: ${err}`);
      }
    }
  }

  async readFileToBuffer(
    input: { path: string },
    options?: { signal?: AbortSignal },
  ): Promise<Buffer | null> {
    const res = await execDocker(
      ["exec", this.sandboxId, "cat", "--", input.path],
      { signal: options?.signal },
    );
    if (res.exitCode !== 0) {
      return null;
    }
    return res.stdout;
  }

  async readFile(
    input: { path: string },
    options?: { signal?: AbortSignal },
  ): Promise<NodeJS.ReadableStream | null> {
    const check = await execDocker(
      ["exec", this.sandboxId, "test", "-f", input.path],
      { signal: options?.signal },
    );
    if (check.exitCode !== 0) {
      return null;
    }
    const child = spawn("docker", ["exec", this.sandboxId, "cat", "--", input.path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stream = child.stdout;
    stream.on("close", () => {
      if (!child.killed) child.kill("SIGTERM");
    });
    return stream;
  }

  async stop(options?: {
    blocking?: boolean;
    signal?: AbortSignal;
  }): Promise<{ status: "stopped" }> {
    await execDocker(["rm", "-f", this.sandboxId], {
      signal: options?.signal,
    }).catch(() => {});
    this.status = "stopped";
    return { status: "stopped" };
  }

  async snapshot(options?: {
    expiration?: number;
    signal?: AbortSignal;
  }): Promise<{
    snapshotId: string;
    sourceSandboxId: string;
    status: "created";
    expiresAt: Date;
  }> {
    const snapshotId = `snap_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const createdAt = Date.now();
    const expirationMs = options?.expiration ?? 7 * 24 * 60 * 60 * 1_000;
    const expiresAtMs = createdAt + expirationMs;
    const tag = snapshotImageTag(snapshotId);

    const commit = await execDocker(
      [
        "commit",
        "-c",
        "LABEL aiw.snapshot=true",
        "-c",
        `LABEL aiw.snapshotId=${snapshotId}`,
        "-c",
        `LABEL aiw.sourceSandboxId=${this.sandboxId}`,
        "-c",
        `LABEL aiw.createdAt=${createdAt}`,
        "-c",
        `LABEL aiw.expiresAt=${expiresAtMs}`,
        this.sandboxId,
        tag,
      ],
      { signal: options?.signal },
    );
    if (commit.exitCode !== 0) {
      const err = commit.stderr.toString("utf8").trim() || "docker commit failed";
      throw new Error(`Failed to snapshot sandbox ${this.sandboxId}: ${err}`);
    }

    await this.stop({ blocking: true, signal: options?.signal });
    return {
      snapshotId,
      sourceSandboxId: this.sandboxId,
      status: "created",
      expiresAt: new Date(expiresAtMs),
    };
  }
}

export interface DockerSnapshotSummary {
  id: string;
  sourceSandboxId: string;
  status: "created";
  createdAt: number;
  expiresAt?: number;
}

export class Snapshot {
  readonly snapshotId: string;

  constructor(snapshotId: string) {
    this.snapshotId = snapshotId;
  }

  static async list(options?: {
    limit?: number;
    since?: Date;
    until?: number;
    signal?: AbortSignal;
    token?: string;
    teamId?: string;
    projectId?: string;
  }): Promise<{
    json: {
      snapshots: DockerSnapshotSummary[];
      pagination: { next: number | null };
    };
  }> {
    const listed = await execDocker(
      [
        "images",
        "--filter",
        "label=aiw.snapshot=true",
        "--format",
        "{{.ID}}",
      ],
      { signal: options?.signal },
    );
    if (listed.exitCode !== 0) {
      return { json: { snapshots: [], pagination: { next: null } } };
    }

    const imageIds = [
      ...new Set(
        listed.stdout
          .toString("utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
    if (imageIds.length === 0) {
      return { json: { snapshots: [], pagination: { next: null } } };
    }

    const inspected = await execDocker(
      [
        "image",
        "inspect",
        "--format",
        "{{index .Config.Labels \"aiw.snapshotId\"}}|{{index .Config.Labels \"aiw.sourceSandboxId\"}}|{{index .Config.Labels \"aiw.createdAt\"}}|{{index .Config.Labels \"aiw.expiresAt\"}}",
        ...imageIds,
      ],
      { signal: options?.signal },
    );
    if (inspected.exitCode !== 0) {
      return { json: { snapshots: [], pagination: { next: null } } };
    }

    const sinceMs = options?.since?.getTime() ?? 0;
    const untilMs = options?.until ?? Number.POSITIVE_INFINITY;
    const snapshots: DockerSnapshotSummary[] = [];

    for (const line of inspected.stdout.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [id, sourceSandboxId, createdAtRaw, expiresAtRaw] = trimmed.split("|");
      const createdAt = Number(createdAtRaw);
      const expiresAt = Number(expiresAtRaw);
      if (!id || !sourceSandboxId || !Number.isFinite(createdAt)) continue;
      if (createdAt < sinceMs || createdAt > untilMs) continue;
      snapshots.push({
        id,
        sourceSandboxId,
        status: "created",
        createdAt,
        ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
      });
    }

    snapshots.sort((a, b) => b.createdAt - a.createdAt);
    const limited = options?.limit ? snapshots.slice(0, options.limit) : snapshots;
    return {
      json: {
        snapshots: limited,
        pagination: { next: null },
      },
    };
  }

  static async get(options: {
    snapshotId: string;
    signal?: AbortSignal;
    token?: string;
    teamId?: string;
    projectId?: string;
  }): Promise<Snapshot> {
    const tag = snapshotImageTag(options.snapshotId);
    const inspect = await execDocker(["image", "inspect", tag], {
      signal: options.signal,
    });
    if (inspect.exitCode !== 0) {
      throw createHttpError(404, `Snapshot ${options.snapshotId} not found`);
    }
    return new Snapshot(options.snapshotId);
  }

  async delete(options?: { signal?: AbortSignal }): Promise<void> {
    const tag = snapshotImageTag(this.snapshotId);
    const res = await execDocker(["rmi", "-f", tag], {
      signal: options?.signal,
    });
    if (res.exitCode !== 0) {
      const err = res.stderr.toString("utf8");
      if (/No such image/i.test(err)) return;
      throw new Error(`Failed to delete snapshot ${this.snapshotId}: ${err.trim()}`);
    }
  }
}
