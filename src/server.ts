#!/usr/bin/env npx tsx

/**
 * Combined Discord AXON Server
 * 
 * Includes both Discord bot connection AND module serving/transpilation
 */

import express from 'express';
import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import WebSocket from 'ws';
import { AxonModuleServer } from '@connectome/axon-server';
import { join } from 'path';
import { loadConfig, DiscordConfig } from './config';

interface AxonConnection {
  ws: WebSocket;
  agentName: string;
  guildId: string;
  joinedChannels: Set<string>;
  lastRead: Map<string, string>;
}

class CombinedDiscordAxonServer {
  private app = express();
  private wss: WebSocket.Server;
  private discord: Client;
  private connections = new Map<string, AxonConnection>();
  private moduleServer: AxonModuleServer;
  private hotReloadWss?: WebSocket.Server;
  
  constructor(
    private httpPort: number = 8080,
    private wsPort: number = 8081,
    private modulePort: number = 8082
  ) {
    // Discord client setup
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
      ]
    });
    
    // WebSocket server for AXON connections
    this.wss = new WebSocket.Server({ port: wsPort });
    
    // Create module server
    this.moduleServer = new AxonModuleServer({
      port: this.modulePort,
      hotReload: true,
      corsOrigin: '*'
    });
    
    // Routes and services setup
    this.setupRoutes();
    this.setupWebSocket();
    this.setupDiscord();
  }
  
  private async registerDiscordModules(): Promise<void> {
    const modulesDir = join(__dirname, 'modules');
    
    // Map module names to their actual file names
    await this.moduleServer.addModule('discord', {
      name: 'discord',
      path: join(modulesDir, 'discord-axon-refactored.ts'),
      manifest: {
        name: 'DiscordAxonComponent',
        version: '1.0.0',
        description: 'Discord integration for Connectome',
        componentClass: 'DiscordAxonComponent',
        moduleType: 'function',
        actions: {
          'join': {
            description: 'Join a Discord channel',
            parameters: { channelId: { type: 'string', required: true } }
          },
          'leave': {
            description: 'Leave a Discord channel',
            parameters: { channelId: { type: 'string', required: true } }
          },
          'send': {
            description: 'Send a message to a channel',
            parameters: { 
              channelId: { type: 'string', required: true },
              message: { type: 'string', required: true }
            }
          }
        }
      }
    });
    
    await this.moduleServer.addModule('discord-chat', {
      name: 'discord-chat',
      path: join(modulesDir, 'discord-chat-refactored.ts'),
      manifest: {
        name: 'DiscordChatComponent',
        version: '1.0.0',
        description: 'Discord chat integration with agent activation',
        componentClass: 'DiscordChatComponent',
        moduleType: 'function',
        extends: 'DiscordAxonComponent',
        dependencies: [
          { name: 'DiscordAxonComponent', manifest: '/modules/discord/manifest' }
        ],
        actions: {
          'setTriggerConfig': {
            description: 'Configure chat triggers',
            parameters: { config: { type: 'object', required: true } }
          }
        }
      }
    });
  }
  
  private setupRoutes() {
    // Mount the module server routes
    this.app.use('/modules', this.moduleServer.getRouter() as any);
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        discord: this.discord.isReady() ? 'connected' : 'disconnected',
        connections: this.connections.size,
        modules: 'available at /modules/manifest'
      });
    });
    
    // Root info
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Combined Discord AXON Server',
        version: '1.0.0',
        endpoints: {
          modules: '/modules/manifest',
          health: '/health',
          websocket: `ws://localhost:${this.wsPort}/ws`
        }
      });
    });
  }
  
  private setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url!, `http://localhost:${this.httpPort}`);
      const path = url.pathname;
      
      if (path !== '/ws') {
        ws.close(1002, 'Invalid path');
        return;
      }
      
      console.log('[Server] New WebSocket connection');
      
      // Wait for auth message
      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'auth') {
            await this.handleAuth(ws, msg);
          } else {
            const connectionId = this.findConnectionId(ws);
            if (connectionId) {
              await this.handleAxonMessage(connectionId, msg);
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Not authenticated'
              }));
            }
          }
        } catch (error: any) {
          console.error('[Server] Message handling error:', error);
          ws.send(JSON.stringify({
            type: 'error',
            error: error.message
          }));
        }
      });
      
      ws.on('close', () => {
        const connectionId = this.findConnectionId(ws);
        if (connectionId) {
          console.log(`[Server] Connection closed: ${connectionId}`);
          this.connections.delete(connectionId);
        }
      });
      
      ws.on('error', (error) => {
        console.error('[Server] WebSocket error:', error);
      });
    });
  }
  
  private findConnectionId(ws: WebSocket): string | undefined {
    for (const [id, conn] of this.connections) {
      if (conn.ws === ws) return id;
    }
    return undefined;
  }
  
  private async handleAuth(ws: WebSocket, msg: any): Promise<void> {
    const { token, guild, agent } = msg;
    
    console.log(`[Server] Auth request from agent: ${agent}, guild: ${guild}`);
    
    // Create connection
    const connectionId = this.generateConnectionId();
    const connection: AxonConnection = {
      ws,
      agentName: agent || 'Agent',
      guildId: guild || '',
      joinedChannels: new Set(),
      lastRead: new Map()
    };
    
    this.connections.set(connectionId, connection);
    
    // Send success with bot user ID
    ws.send(JSON.stringify({
      type: 'authenticated',
      connectionId,
      botUserId: this.discord.user?.id
    }));
    
    console.log(`[Server] Authenticated connection: ${connectionId}`);
  }
  
  private setupDiscord() {
    this.discord.on('ready', () => {
      console.log(`[Discord] Bot logged in as ${this.discord.user?.tag}`);
      console.log(`[Discord] Bot ID: ${this.discord.user?.id}`);
    });
    
    this.discord.on('messageCreate', async (message) => {
      // Skip bot messages (including our own)
      if (message.author.bot) return;
      
      // Forward to all agents that have joined this channel
      for (const [id, connection] of this.connections) {
        if (connection.joinedChannels.has(message.channelId)) {
          connection.ws.send(JSON.stringify({
            type: 'message',
            payload: {
              channelId: message.channelId,
              messageId: message.id,
              author: message.author.username,
              content: message.content,
              timestamp: message.createdAt.toISOString(),
              guildId: message.guildId
            }
          }));
          
          // Update last read
          connection.lastRead.set(message.channelId, message.id);
        }
      }
    });
  }
  
  private async handleAxonMessage(connectionId: string, msg: any): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    console.log(`[Server] Handling message:`, msg.type);
    
    switch (msg.type) {
      case 'join': {
        const { channelId, scrollback = 50, lastMessageId } = msg;
        
        try {
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }
          
          connection.joinedChannels.add(channelId);
          
          // Get messages after lastMessageId if provided, otherwise get recent messages
          const messages = await channel.messages.fetch({ 
            limit: scrollback,
            ...(lastMessageId ? { after: lastMessageId } : {})
          });
          
          // Send history
          // Note: messages.reverse() is only needed when fetching with 'before'
          // With 'after', messages are already in chronological order
          const orderedMessages = lastMessageId ? messages : messages.reverse();
          
          connection.ws.send(JSON.stringify({
            type: 'history',
            channelId: channel.id,
            channelName: channel.name,
            messages: orderedMessages.map(m => ({
              channelId: m.channelId,
              messageId: m.id,
              author: m.author.username,
              content: m.content,
              timestamp: m.createdAt.toISOString()
            }))
          }));
          
          console.log(`[Server] Agent joined channel: ${channel.name} (${channelId})`);
        } catch (error: any) {
          console.error(`[Server] Failed to join channel:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to join channel: ${error.message}`
          }));
        }
        break;
      }
      
      case 'leave': {
        const { channelId } = msg;
        connection.joinedChannels.delete(channelId);
        console.log(`[Server] Agent left channel: ${channelId}`);
        break;
      }
      
      case 'send': {
        const { channelId, message } = msg;
        
        try {
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }
          
          await channel.send(message);
          console.log(`[Server] Sent message to ${channel.name}: ${message}`);
        } catch (error: any) {
          console.error(`[Server] Failed to send message:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to send message: ${error.message}`
          }));
        }
        break;
      }
    }
  }
  
  private generateConnectionId(): string {
    return Math.random().toString(36).substring(2, 15);
  }
  
  /**
   * Notify hot reload clients about module updates
   */
  public notifyModuleUpdate(moduleName: string): void {
    if (!this.hotReloadWss) return;
    
    const notification = JSON.stringify({
      type: 'module-updated',
      module: moduleName,
      timestamp: Date.now()
    });
    
    this.hotReloadWss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(notification);
      }
    });
  }
  
  async init() {
    // Register Discord modules
    await this.registerDiscordModules();
  }
  
  async start(botToken: string) {
    // Start Express server
    this.app.listen(this.httpPort, () => {
      console.log(`\n🚀 Combined Discord AXON Server`);
      console.log(`   HTTP server on port ${this.httpPort}`);
      console.log(`   WebSocket server on port ${this.wsPort}`);
      console.log(`   Module server at http://localhost:${this.httpPort}/modules/manifest`);
      console.log(`\n📡 Agents can connect to: ws://localhost:${this.wsPort}/ws`);
    });
    
    // Start hot reload WebSocket server
    const hotReloadPort = this.modulePort + 1;
    this.hotReloadWss = new WebSocket.Server({ port: hotReloadPort });
    console.log(`   Hot reload WebSocket on port ${hotReloadPort}`);
    
    this.hotReloadWss.on('connection', (ws) => {
      console.log('[HotReload] Client connected');
      
      ws.on('close', () => {
        console.log('[HotReload] Client disconnected');
      });
    });
    
    // Login to Discord
    await this.discord.login(botToken);
  }
}

export { CombinedDiscordAxonServer };
export type { AxonConnection };
