import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface OAuthStorageOptions {
  /** Must be outside WORKSPACE_ROOT. */
  directory: string;
}

export class OAuthStorage {
  private readonly directory: string;
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: OAuthStorageOptions) {
    if (!path.isAbsolute(options.directory)) {
      throw new Error("OAuth storage directory must be an absolute path.");
    }

    this.directory = path.resolve(options.directory);
    this.filePath = path.join(this.directory, "oauth-state.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.withLock(async () => {
      try {
        await readFile(this.filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }

        await this.writeState({
          version: 1,
          clients: {},
          authorizations: {},
          tokens: {},
        });
      }
    });
  }

  async read<T>(): Promise<T> {
    return this.withLock(async () => {
      const text = await readFile(this.filePath, "utf8");
      return JSON.parse(text) as T;
    });
  }

  async update<T, R>(
    updater: (current: T) => { state: T; result: R },
  ): Promise<R> {
    return this.withLock(async () => {
      const text = await readFile(this.filePath, "utf8");
      const current = JSON.parse(text) as T;
      const { state, result } = updater(current);
      await this.writeState(state);
      return result;
    });
  }

  private async writeState(state: unknown): Promise<void> {
    const temporaryPath = path.join(
      this.directory,
      `.oauth-${randomUUID()}.tmp`,
    );

    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;

    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
