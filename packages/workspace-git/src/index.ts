import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function runGit(args: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

export interface Worktree {
  runId: string;
  path: string;
  repositoryPath: string;
  baseCommit: string;
}

export class GitWorkspaceManager {
  constructor(
    readonly repositoryPath: string,
    readonly worktreesPath: string,
  ) {}

  async validate(): Promise<{ path: string; head: string }> {
    const repo = resolve(this.repositoryPath);
    const info = await stat(repo).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`FINALBOT_REPO_PATH is not a directory: ${repo}`);
    }
    const root = await runGit(["rev-parse", "--show-toplevel"], repo);
    if (resolve(root) !== resolve(await realpath(repo))) {
      throw new Error(`FINALBOT_REPO_PATH must point at the repository root: ${repo}`);
    }
    const head = await runGit(["rev-parse", "HEAD"], repo);
    return { path: root, head };
  }

  async create(runId: string): Promise<Worktree> {
    const repo = await this.validate();
    await mkdir(this.worktreesPath, { recursive: true });
    const path = join(this.worktreesPath, runId);
    await runGit(["worktree", "add", "--detach", path, repo.head], repo.path);
    return {
      runId,
      path,
      repositoryPath: repo.path,
      baseCommit: repo.head,
    };
  }

  async diff(worktreePath: string): Promise<string> {
    const status = await runGit(["status", "--short"], worktreePath);
    const diff = await runGit(["diff", "--no-ext-diff", "HEAD"], worktreePath);
    return [status, diff].filter(Boolean).join("\n\n");
  }
}
