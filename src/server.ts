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
    // Always use source directory for modules (AxonModuleServer transpiles them)
    const modulesDir = join(__dirname, '..', 'src', 'modules');
    
    // Register the new Discord Afferent
    await this.moduleServer.addModule('discord-afferent', {
      name: 'discord-afferent',
      path: join(modulesDir, 'discord-afferent.ts'),
      manifest: {
        name: 'DiscordAfferent',
        version: '2.0.0',
        description: 'Discord WebSocket afferent for RETM architecture',
        componentClass: 'DiscordAfferent',
        moduleType: 'function',
        exports: {
          afferents: ['DiscordAfferent']
        },
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
    
    // Keep old discord module for backward compatibility
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
            parameters: { config: { type: 'object', required: true }             }
          }
        }
      }
    });
    
    await this.moduleServer.addModule('discord-control-panel', {
      name: 'discord-control-panel',
      path: join(modulesDir, 'discord-control-panel.ts'),
      manifest: {
        name: 'DiscordControlPanelComponent',
        version: '1.0.0',
        description: 'Discord server and channel management UI',
        componentClass: 'DiscordControlPanelComponent',
        moduleType: 'function',
        actions: {
          'listServers': {
            description: 'List all Discord servers',
            parameters: {}
          },
          'selectServer': {
            description: 'Select a server',
            parameters: { serverName: { type: 'string', required: true } }
          },
          'listChannels': {
            description: 'List channels in a server',
            parameters: { serverName: { type: 'string', required: false } }
          },
          'joinChannel': {
            description: 'Join a channel',
            parameters: { 
              channelName: { type: 'string', required: true },
              serverName: { type: 'string', required: false }
            }
          },
          'leaveChannel': {
            description: 'Leave a channel',
            parameters: { 
              channelName: { type: 'string', required: true },
              serverName: { type: 'string', required: false }
            }
          },
          'showJoinedChannels': {
            description: 'Show all joined channels',
            parameters: {}
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
      // Skip messages from our own bot to prevent loops
      if (message.author.id === this.discord.user?.id) return;
      
      // Forward to all agents that have joined this channel
      for (const [id, connection] of this.connections) {
        if (connection.joinedChannels.has(message.channelId)) {
          connection.ws.send(JSON.stringify({
            type: 'message',
            payload: {
              channelId: message.channelId,
              messageId: message.id,
              author: message.author.username,
              authorId: message.author.id,
              isBot: message.author.bot,
              content: message.content,
              timestamp: message.createdAt.toISOString(),
              guildId: message.guildId,
              guildName: message.guild?.name,
              channelName: (message.channel as TextChannel).name
            }
          }));
          
          // Update last read
          connection.lastRead.set(message.channelId, message.id);
        }
      }
    });
    
    // Handle message edits
    this.discord.on('messageUpdate', async (oldMessage, newMessage) => {
      // Forward to all agents that have joined this channel
      // Note: We don't filter bot messages here - agents need to know about edits to all messages
      for (const [id, connection] of this.connections) {
        if (connection.joinedChannels.has(newMessage.channelId)) {
          connection.ws.send(JSON.stringify({
            type: 'messageUpdate',
            payload: {
              channelId: newMessage.channelId,
              messageId: newMessage.id,
              author: newMessage.author?.username,
              authorId: newMessage.author?.id,
              isBot: newMessage.author?.bot || false,
              content: newMessage.content,
              oldContent: oldMessage.content,
              timestamp: newMessage.editedAt?.toISOString() || newMessage.createdAt?.toISOString(),
              guildId: newMessage.guildId,
              guildName: newMessage.guild?.name,
              channelName: (newMessage.channel as TextChannel).name
            }
          }));
        }
      }
    });
    
    // Handle message deletes
    this.discord.on('messageDelete', async (message) => {
      // Forward to all agents that have joined this channel
      for (const [id, connection] of this.connections) {
        if (connection.joinedChannels.has(message.channelId)) {
          connection.ws.send(JSON.stringify({
            type: 'messageDelete',
            payload: {
              channelId: message.channelId,
              messageId: message.id,
              author: message.author?.username,
              authorId: message.author?.id,
              isBot: message.author?.bot || false,
              timestamp: new Date().toISOString(),
              guildId: message.guildId,
              guildName: message.guild?.name,
              channelName: (message.channel as TextChannel).name
            }
          }));
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
            guildId: channel.guildId,
            guildName: channel.guild?.name,
            messages: orderedMessages.map(m => ({
              channelId: m.channelId,
              messageId: m.id,
              author: m.author.username,
              content: m.content,
              timestamp: m.createdAt.toISOString()
            }))
          }));
          
          // Send joined confirmation with channel info
          connection.ws.send(JSON.stringify({
            type: 'joined',
            channel: {
              id: channel.id,
              name: channel.name,
              type: channel.type,
              guildId: channel.guildId,
              guildName: channel.guild?.name
            }
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
        
        // Send left confirmation
        connection.ws.send(JSON.stringify({
          type: 'left',
          channelId
        }));
        
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
          
          const sentMessage = await channel.send(message);
          console.log(`[Server] Sent message to ${channel.name}: ${message} (ID: ${sentMessage.id})`);
          
          // Send confirmation back to client with message ID
          connection.ws.send(JSON.stringify({
            type: 'message_sent',
            channelId: channelId,
            messageId: sentMessage.id,
            content: message,
            timestamp: sentMessage.createdAt.toISOString()
          }));
        } catch (error: any) {
          console.error(`[Server] Failed to send message:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to send message: ${error.message}`
          }));
        }
        break;
      }
      
      case 'listGuilds': {
        try {
          const guilds = this.discord.guilds.cache.map(guild => ({
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL(),
            memberCount: guild.memberCount
          }));
          
          connection.ws.send(JSON.stringify({
            type: 'guilds',
            guilds
          }));
          
          console.log(`[Server] Sent guilds list to ${connection.agentName} (${guilds.length} guilds)`);
        } catch (error: any) {
          console.error(`[Server] Failed to list guilds:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to list guilds: ${error.message}`
          }));
        }
        break;
      }
      
      case 'listChannels': {
        const { guildId } = msg;
        
        try {
          const guild = await this.discord.guilds.fetch(guildId);
          if (!guild) {
            throw new Error('Guild not found');
          }
          
          const channels = guild.channels.cache
            .filter(channel => channel.isTextBased())
            .map(channel => ({
              id: channel.id,
              name: channel.name,
              type: channel.type,
              guildId: guild.id,
              guildName: guild.name,
              parentId: channel.parentId,
              position: 'position' in channel ? channel.position : 0
            }))
            .sort((a, b) => a.position - b.position);
          
          connection.ws.send(JSON.stringify({
            type: 'channels',
            guildId,
            channels
          }));
          
          console.log(`[Server] Sent channels list for guild ${guild.name} to ${connection.agentName} (${channels.length} channels)`);
        } catch (error: any) {
          console.error(`[Server] Failed to list channels:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to list channels: ${error.message}`
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
