import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";

export interface Mp4Atom {
  header: Buffer;
  length: number;
  type: string;
  data: Buffer;
}

export class Mp4StreamingServer {
  readonly server: Server;
  socket?: Socket;
  childProcess?: ChildProcess;
  destroyed = false;
  /** Set when the ffmpeg process has exited, including an intentional kill. */
  exited = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  /** Rolling stderr, so an exit log can include ffmpeg's last line. */
  stderrTail = "";
  private connectResolve?: () => void;
  private connectReject?: (err: Error) => void;
  private readonly connectPromise: Promise<void>;
  /** Resolved from the child "exit" handler, including an intentional kill. */
  private readonly processExit: Promise<void>;
  private resolveProcessExit: () => void = () => undefined;

  constructor(
    private readonly ffmpegPath: string,
    private readonly args: string[],
    private readonly verbose: boolean,
  ) {
    this.processExit = new Promise((resolve) => {
      this.resolveProcessExit = resolve;
    });
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    // consume() may not be awaiting yet if ffmpeg exits during startup.
    void this.connectPromise.catch(() => undefined);
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    const listening = once(this.server, "listening");
    this.server.listen(0, "127.0.0.1");
    await listening;
    if (this.destroyed) return;

    const port = (this.server.address() as AddressInfo).port;
    const args = [...this.args, `tcp://127.0.0.1:${port}`];
    if (this.verbose) {
      console.log(`${this.ffmpegPath} ${args.join(" ")}`);
    }

    this.childProcess = spawn(this.ffmpegPath, args, {
      env: process.env,
      // stderr stays a pipe so the exit log has ffmpeg's last line when verbose is off.
      stdio: ["ignore", this.verbose ? "pipe" : "ignore", "pipe"],
    });
    if (this.verbose) {
      this.childProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    }
    this.childProcess.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
      if (this.verbose) process.stderr.write(d);
    });
    this.childProcess.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.resolveProcessExit();
      if (this.destroyed) return;
      // An exit before the TCP accept leaves the reader blocked forever.
      this.connectReject?.(new Error(`ffmpeg exited ${code}/${signal}`));
      this.socket?.destroy();
    });
  }

  /**
   * Resolves when ffmpeg exits, or after `timeoutMs` if it is still running.
   * A process that has already exited resolves immediately.
   */
  waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, timeoutMs);
      void this.processExit.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    // Unblock a reader still waiting for the first TCP connection.
    this.connectReject?.(new Error("ffmpeg closed the fMP4 socket"));
    this.socket?.destroy();
    try {
      this.childProcess?.kill("SIGKILL");
    } catch {
      // already gone, or the process could not be signalled
    }
    try {
      this.server.close();
    } catch {
      // already closed
    }
    this.socket = undefined;
    this.childProcess = undefined;
  }

  private handleConnection(socket: Socket): void {
    this.server.close();
    this.socket = socket;
    this.connectResolve?.();
  }

  async *generator(): AsyncGenerator<Mp4Atom> {
    await this.connectPromise;
    if (!this.socket || !this.childProcess) {
      throw new Error("fMP4 server failed to start");
    }
    while (true) {
      const header = await this.read(8);
      const length = header.readInt32BE(0) - 8;
      const type = header.subarray(4).toString();
      const data = await this.read(length);
      yield { header, length, type, data };
    }
  }

  private async read(length: number): Promise<Buffer> {
    if (!this.socket) throw new Error("ffmpeg closed the fMP4 socket");
    if (!length) return Buffer.alloc(0);
    const immediate = this.socket.read(length) as Buffer | null;
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
      const onReadable = () => {
        const value = this.socket?.read(length) as Buffer | null;
        if (value) {
          cleanup();
          resolve(value);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`ffmpeg socket closed while reading ${length} bytes`));
      };
      const cleanup = () => {
        this.socket?.off("readable", onReadable);
        this.socket?.off("close", onClose);
      };
      this.socket!.on("readable", onReadable);
      this.socket!.on("close", onClose);
    });
  }
}
