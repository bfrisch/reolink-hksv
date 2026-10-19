declare module "onvif" {
  /**
   * Minimal `onvif` Cam surface used to discover an RTSP URL.
   * The published package has no usable types, so only the calls we make are declared.
   */
  export class Cam {
    /**
     * Connect to a camera's ONVIF device service.
     *
     * @param options - host, credentials, port, and timeout
     * @param callback - invoked with a connection error, or null on success
     */
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
    /**
     * List media profiles. The token lives on the profile or its `$` attribute, depending on the camera.
     *
     * @param callback - profiles, or an error
     */
    getProfiles(callback: (err: Error | null, profiles?: unknown[]) => void): void;
    /**
     * Resolve a profile token to a stream URI.
     *
     * @param options - transport, profile token, and stream type
     * @param callback - stream object containing `uri`, or an error
     */
    getStreamUri(
      options: { protocol?: string; profileToken?: string; stream?: string },
      callback: (err: Error | null, stream?: { uri?: string }) => void,
    ): void;
  }

  const onvif: { Cam: typeof Cam };
  export default onvif;
}
