export interface TransportCapabilities {
  readonly supportsRequestReply: boolean;
  readonly supportsBroadcast: boolean;
  readonly supportsScheduling: boolean;
  readonly supportsDurability: boolean;
}
