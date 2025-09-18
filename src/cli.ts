#!/usr/bin/env node

/**
 * CLI entry point for Discord AXON Server
 */

import { CombinedDiscordAxonServer } from './server';
import { loadConfig } from './config';

async function main() {
  try {
    const config = loadConfig();
    
    console.log('🚀 Starting Discord AXON Server...');
    console.log(`📡 HTTP Port: ${config.httpPort || 8080}`);
    console.log(`🔌 WebSocket Port: ${config.wsPort || 8081}`);
    console.log(`📦 Module Port: ${config.modulePort || 8082}`);
    
    const server = new CombinedDiscordAxonServer(
      config.httpPort || 8080,
      config.wsPort || 8081
    );
    
    await server.init();
    await server.start(config.botToken);
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

// Run the server
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
