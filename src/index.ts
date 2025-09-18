/**
 * Discord AXON Server
 * 
 * Main entry point for the Discord integration server
 */

export { CombinedDiscordAxonServer } from './server';
export { loadConfig, DiscordConfig } from './config';

// Re-export module interfaces for external use
export type { AxonConnection } from './server';
