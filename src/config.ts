import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

export interface DiscordConfig {
  botToken: string;
  httpPort?: number;
  wsPort?: number;
  modulePort?: number;
  debug?: boolean;
}

export function loadConfig(): DiscordConfig {
  // Check environment variables first
  if (process.env.DISCORD_BOT_TOKEN) {
    return {
      botToken: process.env.DISCORD_BOT_TOKEN,
      httpPort: parseInt(process.env.HTTP_PORT || '8080'),
      wsPort: parseInt(process.env.WS_PORT || '8081'),
      modulePort: parseInt(process.env.MODULE_PORT || '8082'),
      debug: process.env.DEBUG === 'true'
    };
  }

  // Try to load from config file
  const configPaths = [
    join(process.cwd(), 'config.yaml'),
    join(process.cwd(), 'discord_config.yaml'),
    join(process.cwd(), '../connectome-adapters/config/discord_config.yaml')
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const configContent = readFileSync(configPath, 'utf8');
        const config = yaml.load(configContent) as any;
        
        if (config.discord?.botToken) {
          return {
            botToken: config.discord.botToken,
            httpPort: config.discord.httpPort || 8080,
            wsPort: config.discord.wsPort || 8081,
            modulePort: config.discord.modulePort || 8082,
            debug: config.discord.debug || false
          };
        }
      } catch (error) {
        console.error(`Error loading config from ${configPath}:`, error);
      }
    }
  }

  throw new Error(
    'Discord bot token not found. Please set DISCORD_BOT_TOKEN environment variable ' +
    'or create a config.yaml file with discord.botToken'
  );
}
