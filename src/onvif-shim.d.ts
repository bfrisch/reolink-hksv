declare module "onvif" {
  export class Cam {
    constructor(
      options: {
        hostname: string;
        username?: string;
        password?: string;
        port?: number;
        timeout?: number;
        preserveAddress?: boolean;
      },
      callback: (err: Error | null) => void,
    );
    getProfiles(callback: (err: Error | null, profiles?: unknown[]) => void): void;
    getStreamUri(
      options: { protocol?: string; profileToken?: string; stream?: string },
      callback: (err: Error | null, stream?: { uri?: string }) => void,
    ): void;
  }

  const onvif: { Cam: typeof Cam };
  export default onvif;
}
