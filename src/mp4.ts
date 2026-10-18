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
  private connectResolve?: () => void;
  private readonly connectPromise: Promise<void>;

  constructor(
    private readonly ffmpegPath: string,
    private readonly args: string[],
    private readonly verbose: boolean,
  ) {
    this.connectPromise = new Promise((resolve) => {
      this.connectResolve = resolve;
    });
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
      stdio: ["ignore", this.verbose ? "pipe" : "ignore", this.verbose ? "pipe" : "ignore"],
    });
    if (this.verbose) {
      this.childProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
      this.childProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.socket?.destroy();
    this.childProcess?.kill("SIGKILL");
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
