/**
 * Called whenever devices lose access (logout, device removal, admin disable, expiry).
 * Group 4/6 implement this against the gateway xray API and OpenVPN management; until then it is a no-op.
 */
export interface CredentialRevoker {
  revokeDevices(deviceIds: string[]): Promise<void>;
}

export const noopRevoker: CredentialRevoker = {
  async revokeDevices() {},
};
