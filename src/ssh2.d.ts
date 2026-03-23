declare module "ssh2" {
  import type { EventEmitter } from "node:events";
  import type { Readable, Writable } from "node:stream";

  export type ConnectConfig = {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string | Buffer;
    agent?: string;
    readyTimeout?: number;
    hostVerifier?: (hostKey: Buffer) => boolean;
  };

  export interface Stats {
    size?: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface FileEntry {
    filename: string;
    longname: string;
    attrs: Stats;
  }

  export interface ClientChannel extends EventEmitter {
    stderr: Readable;
    pipe<T extends Writable>(destination: T): T;
    on(event: "close", listener: (exitCode: number | null) => void): this;
    on(event: "data", listener: (chunk: Buffer | string) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export interface SFTPWrapper {
    readdir(remotePath: string, callback: (error: Error | undefined, list: FileEntry[] | undefined) => void): void;
    mkdir(remotePath: string, callback: (error?: Error) => void): void;
    stat(remotePath: string, callback: (error: Error | undefined, stats: Stats) => void): void;
    createReadStream(remotePath: string): Readable;
    createWriteStream(remotePath: string): Writable;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    end(): void;
    sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): void;
    exec(command: string, callback: (error: Error | undefined, stream: ClientChannel) => void): void;
    once(event: "ready", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
  }
}
