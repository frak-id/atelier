export interface BridgeStatus {
  exists: boolean;
  ip: string | null;
  interfaces: string[];
}

export interface NetworkProvider {
  /** Provider name for logging and diagnostics */
  readonly name: string;

  /**
   * Create a TAP device and attach it to the network.
   */
  createTap(tapDevice: string): Promise<void>;

  /**
   * Delete a TAP device.
   */
  deleteTap(tapDevice: string): Promise<void>;

  /**
   * List all TAP devices managed by this provider.
   */
  listTapDevices(): Promise<string[]>;

  /**
   * Get the status of the network bridge.
   */
  getBridgeStatus(): Promise<BridgeStatus>;

  /**
   * Check if the network infrastructure is healthy.
   */
  isHealthy(): Promise<boolean>;
}
