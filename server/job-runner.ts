import { spawn } from "node:child_process";
import path from "node:path";
import { localJobStore, type JobStore, type LocalJob } from "./job-store";

export interface JobRunner {
  start(job: LocalJob): void;
}

const activeJobs = new Set<string>();

export class LocalJobRunner implements JobRunner {
  constructor(private readonly store: JobStore) {}

  start(job: LocalJob) {
    if (activeJobs.has(job.id)) return;
    activeJobs.add(job.id);
    void this.run(job).finally(() => activeJobs.delete(job.id));
  }

  private async run(job: LocalJob) {
    try {
      await this.store.update(job.id, { status: "running" });
      const script = path.join(process.cwd(), "archive-sakamichi-blog.mjs");
      const child = spawn(process.execPath, [
        script,
        "--url", job.articleUrl,
        "--output", job.outputDirectory,
        "--limit", "1",
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });

      let pending = Promise.resolve();
      let transcript = "";
      const append = (chunk: Buffer) => {
        transcript += chunk.toString("utf8");
        const lines = transcript.split(/\r?\n/);
        transcript = lines.pop() ?? "";
        if (!lines.length) return;
        pending = pending.then(async () => {
          const current = await this.store.get(job.id);
          if (current) {
            await this.store.update(job.id, {
              log: [...current.log, ...lines].slice(-80),
            });
          }
        });
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code) => resolve({ code }));
      });
      if (transcript) {
        const lastLine = transcript;
        pending = pending.then(async () => {
          const current = await this.store.get(job.id);
          if (current) {
            await this.store.update(job.id, {
              log: [...current.log, lastLine].slice(-80),
            });
          }
        });
      }
      await pending;
      await this.store.update(job.id, result.code === 0
        ? { status: "succeeded" }
        : { status: "failed", error: result.error?.message ?? "取得処理が完了しませんでした。" });
    } catch (error) {
      await this.store.update(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "予期しないエラーが発生しました。",
      }).catch(() => {});
    }
  }
}

export const localJobRunner: JobRunner = new LocalJobRunner(localJobStore);
