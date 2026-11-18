// ISSUE-96: managed detached-child lifecycle. Spawning is not readiness, and a
// returned PID is not proof that the intended process is still running. This
// service records spawn errors and exit state immediately, exposes an explicit
// readiness gate, and can stop only the exact child it owns.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ManagedStopResult =
  "not-spawned" | "already-exited" | "terminated" | "force-killed" | "still-running";

export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  isRunning(): boolean;
  /** Resolves after the OS reports spawn; rejects on spawn failure. */
  waitForSpawn(): Promise<number>;
  /** Wait for exit, bounded. Never signals the child. */
  waitForExit(ms: number): Promise<boolean>;
  /** Stop this exact child, escalating from SIGTERM to SIGKILL. */
  stop(graceMs?: number, killWaitMs?: number): Promise<ManagedStopResult>;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(
      () => {
        child.off("exit", onExit);
        resolve(false);
      },
      Math.max(0, ms),
    );
    child.once("exit", onExit);
  });
}

/**
 * Spawn one child and attach lifecycle listeners immediately. The caller gets
 * an explicit spawn promise so an ENOENT cannot crash the MCP server and an
 * exit before readiness is visible instead of being treated as success.
 */
export function spawnManaged(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ManagedProcess {
  const child = spawn(command, [...args], options);
  let exited = false;
  let spawnError: Error | null = null;

  const spawned = new Promise<number>((resolve, reject) => {
    child.once("spawn", () => {
      if (options.detached) child.unref();
      resolve(child.pid as number);
    });
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
      reject(spawnError);
    });
  });
  // A caller may only inspect the handle and never wait for spawn. Keep the
  // rejection observable through waitForSpawn without generating an unhandled
  // rejection in that case.
  spawned.catch(() => {});

  child.once("exit", () => {
    exited = true;
  });

  const handle: ManagedProcess = {
    child,
    get pid() {
      return child.pid;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    isRunning(): boolean {
      return (
        typeof child.pid === "number" &&
        child.pid > 0 &&
        !exited &&
        spawnError === null &&
        child.exitCode === null &&
        child.signalCode === null
      );
    },
    waitForSpawn(): Promise<number> {
      return spawned;
    },
    waitForExit(ms: number): Promise<boolean> {
      return waitForExit(child, ms);
    },
    async stop(graceMs = 5_000, killWaitMs = 2_000): Promise<ManagedStopResult> {
      if (!child.pid) return "not-spawned";
      if (!handle.isRunning()) return "already-exited";
      child.kill("SIGTERM");
      if (await waitForExit(child, graceMs)) return "terminated";
      child.kill("SIGKILL");
      return (await waitForExit(child, killWaitMs)) ? "force-killed" : "still-running";
    },
  };
  return handle;
}
