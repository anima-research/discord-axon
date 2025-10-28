#!/usr/bin/env npx tsx

/**
 * Combined Discord AXON Server
 * 
 * Includes both Discord bot connection AND module serving/transpilation
 */

import express from 'express';
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  REST,
  Routes,
  SlashCommandBuilder,
  CommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionType,
  ComponentType
} from 'discord.js';
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
  registeredCommands: Set<string>; // Track slash commands registered by this connection
  pendingInteractions: Map<string, any>; // Track interactions awaiting response
}

class CombinedDiscordAxonServer {
  private app = express();
  private wss: WebSocket.Server;
  private discord: Client;
  private rest?: REST; // Discord REST API client for slash commands
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
    // Determine if running from compiled dist/ or source src/
    // Check if current file ends with .ts (dev/ts-node) or .js (compiled)
    const isCompiledContext = __filename.endsWith('.js') && __dirname.includes('/dist');
    const isDevelopment = __filename.endsWith('.ts') || !__dirname.includes('/dist');

    const modulesDir = isCompiledContext
      ? join(__dirname, '..', 'src', 'modules')  // dist/ -> ../src/modules
      : join(__dirname, 'modules');              // src/ -> modules (when running from src/)

    console.log(`[Server] Module registration - isDev: ${isDevelopment}, modulesDir: ${modulesDir}`);
    
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
    
    // Register element-control module
    await this.moduleServer.addModule('element-control', {
      name: 'element-control',
      path: join(modulesDir, 'element-control.ts'),
      manifest: {
        name: 'ElementControlComponent',
        version: '1.0.0',
        description: 'Element creation and management control panel',
        componentClass: 'ElementControlComponent',
        moduleType: 'function',
        exports: {
          receptors: ['ElementControlActionsReceptor']
        },
        actions: {
          'createElement': {
            description: 'Create a new element with custom configuration',
            parameters: {
              elementId: { type: 'string', required: true },
              name: { type: 'string', required: true },
              elementType: { type: 'string', required: false },
              componentType: { type: 'string', required: false },
              componentConfig: { type: 'object', required: false }
            }
          },
          'createBox': {
            description: 'Create a new box element with an agent',
            parameters: {
              boxName: { type: 'string', required: true }
            }
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
      
      ws.on('close', async () => {
        const connectionId = this.findConnectionId(ws);
        if (connectionId) {
          console.log(`[Server] Connection closed: ${connectionId}`);

          // Clean up registered slash commands
          const connection = this.connections.get(connectionId);
          if (connection && connection.registeredCommands.size > 0) {
            console.log(`[Server] Cleaning up ${connection.registeredCommands.size} slash commands`);
            for (const commandName of connection.registeredCommands) {
              await this.unregisterSlashCommand(connection.guildId, commandName);
            }
          }

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
      lastRead: new Map(),
      registeredCommands: new Set(),
      pendingInteractions: new Map()
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
  
  // Cache for reverse mention lookups (name -> ID)
  private userNameToId = new Map<string, string>();
  private channelNameToId = new Map<string, string>();
  private roleNameToId = new Map<string, string>();

  /**
   * Parse Discord mentions and replace them with human-readable text
   * Returns both parsed content and mention metadata
   */
  private parseMentions(message: any): { content: string; mentions: any } {
    let content = message.content;
    const mentions: any = {
      users: [],
      channels: [],
      roles: []
    };

    // Parse user mentions
    if (message.mentions?.users?.size > 0) {
      message.mentions.users.forEach((user: any) => {
        const mentionPattern = new RegExp(`<@!?${user.id}>`, 'g');
        content = content.replace(mentionPattern, `<@${user.username}>`);
        mentions.users.push({
          id: user.id,
          username: user.username,
          displayName: user.displayName || user.username,
          bot: user.bot || false
        });
        
        // Cache for reverse lookup
        this.userNameToId.set(user.username.toLowerCase(), user.id);
      });
    }

    // Parse channel mentions
    if (message.mentions?.channels?.size > 0) {
      message.mentions.channels.forEach((channel: any) => {
        const mentionPattern = new RegExp(`<#${channel.id}>`, 'g');
        content = content.replace(mentionPattern, `<#${channel.name}>`);
        mentions.channels.push({
          id: channel.id,
          name: channel.name,
          type: channel.type
        });
        
        // Cache for reverse lookup
        this.channelNameToId.set(channel.name.toLowerCase(), channel.id);
      });
    }

    // Parse role mentions
    if (message.mentions?.roles?.size > 0) {
      message.mentions.roles.forEach((role: any) => {
        const mentionPattern = new RegExp(`<@&${role.id}>`, 'g');
        content = content.replace(mentionPattern, `<@${role.name}>`);
        mentions.roles.push({
          id: role.id,
          name: role.name,
          color: role.color
        });
        
        // Cache for reverse lookup
        this.roleNameToId.set(role.name.toLowerCase(), role.id);
      });
    }

    return { content, mentions };
  }

  /**
   * Convert human-readable mentions back to Discord IDs for sending
   * Transforms: <@username> -> <@USER_ID>
   *            <#channelname> -> <#CHANNEL_ID>
   *            <@rolename> -> <@&ROLE_ID>
   */
  private async unparseMentions(content: string, guildId?: string): Promise<string> {
    let result = content;
    
    // Collect all replacements to do at once (to avoid conflicts)
    const replacements: Array<{ from: string; to: string }> = [];

    // Find all channel mentions: <#channelname>
    const channelMentionPattern = /<#([a-zA-Z0-9_-]+)>/g;
    const channelMatches = [...content.matchAll(channelMentionPattern)];
    
    for (const match of channelMatches) {
      const channelName = match[1];
      const channelNameLower = channelName.toLowerCase();
      
      // Try cache first
      let channelId = this.channelNameToId.get(channelNameLower);
      
      // If not in cache, try to find in Discord
      if (!channelId && guildId) {
        try {
          const guild = await this.discord.guilds.fetch(guildId);
          const channel = guild.channels.cache.find(c => 
            c.name.toLowerCase() === channelNameLower
          );
          if (channel) {
            channelId = channel.id;
            this.channelNameToId.set(channelNameLower, channelId);
          }
        } catch (error) {
          console.warn(`[Server] Could not resolve channel mention: ${channelName}`);
        }
      }
      
      if (channelId) {
        replacements.push({ from: `<#${channelName}>`, to: `<#${channelId}>` });
      }
    }

    // Find all @ mentions (users or roles): <@name>
    const atMentionPattern = /<@([a-zA-Z0-9_-]+)>/g;
    const atMatches = [...content.matchAll(atMentionPattern)];
    
    for (const match of atMatches) {
      const name = match[1];
      const nameLower = name.toLowerCase();
      
      // Try as user first
      let userId = this.userNameToId.get(nameLower);
      
      if (userId) {
        replacements.push({ from: `<@${name}>`, to: `<@${userId}>` });
        continue;
      }
      
      // Try as role
      let roleId = this.roleNameToId.get(nameLower);
      
      if (roleId) {
        replacements.push({ from: `<@${name}>`, to: `<@&${roleId}>` });
        continue;
      }
      
      // If not in cache, try to find in Discord
      if (guildId) {
        try {
          const guild = await this.discord.guilds.fetch(guildId);
          
          // Try to find as user - search by username
          try {
            const members = await guild.members.search({ query: name, limit: 10 });
            const member = members.find(m => 
              m.user.username.toLowerCase() === nameLower
            );
            if (member) {
              userId = member.user.id;
              this.userNameToId.set(nameLower, userId);
              replacements.push({ from: `<@${name}>`, to: `<@${userId}>` });
              console.log(`[Server] Resolved mention <@${name}> -> <@${userId}> via Discord API`);
              continue;
            }
          } catch (searchError) {
            // Search failed, try fetching all members
            console.log(`[Server] Member search failed for ${name}, trying full fetch`);
            const members = await guild.members.fetch({ limit: 1000 });
            const member = members.find(m => 
              m.user.username.toLowerCase() === nameLower
            );
            if (member) {
              userId = member.user.id;
              this.userNameToId.set(nameLower, userId);
              replacements.push({ from: `<@${name}>`, to: `<@${userId}>` });
              console.log(`[Server] Resolved mention <@${name}> -> <@${userId}> via full member fetch`);
              continue;
            }
          }
          
          // Try to find as role
          const role = guild.roles.cache.find(r => 
            r.name.toLowerCase() === nameLower
          );
          if (role) {
            roleId = role.id;
            this.roleNameToId.set(nameLower, roleId);
            replacements.push({ from: `<@${name}>`, to: `<@&${roleId}>` });
            continue;
          }
          
          console.warn(`[Server] Could not resolve mention: ${name}`);
        } catch (error) {
          console.warn(`[Server] Error resolving mention ${name}:`, error);
        }
      }
    }

    // Apply all replacements
    for (const { from, to } of replacements) {
      result = result.replace(from, to);
    }

    return result;
  }

  private setupDiscord() {
    this.discord.on('ready', () => {
      console.log(`[Discord] Bot logged in as ${this.discord.user?.tag}`);
      console.log(`[Discord] Bot ID: ${this.discord.user?.id}`);
    });

    // Handle slash commands and button interactions
    this.discord.on('interactionCreate', async (interaction) => {
      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        console.log(`[Discord] Slash command received: /${interaction.commandName}`);

        // Find the connection that should handle this interaction
        // Route based on guild membership
        for (const [id, connection] of this.connections) {
          if (interaction.guildId && interaction.guildId === connection.guildId) {
            // Store interaction for potential response
            connection.pendingInteractions.set(interaction.id, interaction);

            // Forward to AXON client
            connection.ws.send(JSON.stringify({
              type: 'interaction:slash-command',
              payload: {
                interactionId: interaction.id,
                commandName: interaction.commandName,
                options: interaction.options.data.map((opt: any) => ({
                  name: opt.name,
                  type: opt.type,
                  value: opt.value
                })),
                user: interaction.user.username,
                userId: interaction.user.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId
              }
            }));

            console.log(`[Discord] Forwarded slash command to connection: ${id}`);
            break;
          }
        }
      }

      // Handle button interactions
      else if (interaction.isButton()) {
        console.log(`[Discord] Button interaction: ${interaction.customId}`);

        // Find the connection that should handle this interaction
        for (const [id, connection] of this.connections) {
          if (interaction.guildId && interaction.guildId === connection.guildId) {
            // Store interaction for potential response
            connection.pendingInteractions.set(interaction.id, interaction);

            // Forward to AXON client
            connection.ws.send(JSON.stringify({
              type: 'interaction:button',
              payload: {
                interactionId: interaction.id,
                customId: interaction.customId,
                user: interaction.user.username,
                userId: interaction.user.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId,
                messageId: interaction.message.id
              }
            }));

            console.log(`[Discord] Forwarded button interaction to connection: ${id}`);
            break;
          }
        }
      }
    });
    
    this.discord.on('messageCreate', async (message) => {
      // Skip messages from our own bot to prevent loops
      if (message.author.id === this.discord.user?.id) return;
      
      // Cache the message author for reverse lookups (so bot can mention them back)
      this.userNameToId.set(message.author.username.toLowerCase(), message.author.id);
      
      // Parse mentions
      const { content, mentions } = this.parseMentions(message);
      
      // Extract reply information
      let replyInfo = null;
      if (message.reference && message.reference.messageId) {
        // Try to get the referenced message from cache
        const referencedMessage = message.channel.messages.cache.get(message.reference.messageId);
        replyInfo = {
          messageId: message.reference.messageId,
          author: referencedMessage?.author.username,
          authorId: referencedMessage?.author.id
        };
        console.log(`[Server] Reply detected: user ${message.author.username} replying to message ${message.reference.messageId} (author: ${replyInfo.authorId})`);
      }
      
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
              content: content, // Parsed content with human-readable mentions
              rawContent: message.content, // Original content with Discord IDs
              mentions: mentions, // Structured mention metadata
              reply: replyInfo, // Reply information if this is a reply
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
      
      // Parse mentions for both old and new content
      const oldParsed = oldMessage.content ? this.parseMentions(oldMessage) : { content: '', mentions: null };
      const newParsed = newMessage.content ? this.parseMentions(newMessage) : { content: '', mentions: null };
      
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
              content: newParsed.content, // Parsed new content
              rawContent: newMessage.content, // Original new content
              oldContent: oldParsed.content, // Parsed old content
              rawOldContent: oldMessage.content, // Original old content
              mentions: newParsed.mentions, // Mention metadata
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
          
          // Cache channel name for reverse lookups
          this.channelNameToId.set(channel.name.toLowerCase(), channel.id);
          
          // Cache guild members for reverse user lookups
          if (channel.guild) {
            const members = await channel.guild.members.fetch({ limit: 100 });
            members.forEach(member => {
              this.userNameToId.set(member.user.username.toLowerCase(), member.user.id);
            });
            
            // Cache roles for reverse role lookups
            channel.guild.roles.cache.forEach(role => {
              this.roleNameToId.set(role.name.toLowerCase(), role.id);
            });
          }
          
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
            messages: orderedMessages.map(m => {
              const { content, mentions } = this.parseMentions(m);
              return {
                channelId: m.channelId,
                messageId: m.id,
                author: m.author.username,
                authorId: m.author.id,
                isBot: m.author.bot,
                content: content, // Parsed content with human-readable mentions
                rawContent: m.content, // Original content with Discord IDs
                mentions: mentions, // Structured mention metadata
                timestamp: m.createdAt.toISOString()
              };
            })
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
          
          // Convert human-readable mentions to Discord IDs
          const discordMessage = await this.unparseMentions(message, channel.guildId);
          
          const sentMessage = await channel.send(discordMessage);
          console.log(`[Server] Sent message to ${channel.name}: ${message} -> ${discordMessage} (ID: ${sentMessage.id})`);
          
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

      case 'registerSlashCommand': {
        const { name, description, options = [] } = msg;

        try {
          // Wait for Discord to be ready
          if (!this.discord.isReady()) {
            console.log(`[Server] Waiting for Discord to be ready before registering /${name}...`);
            await new Promise<void>((resolve) => {
              if (this.discord.isReady()) {
                resolve();
              } else {
                this.discord.once('ready', () => resolve());
              }
            });
          }

          await this.registerSlashCommand(connection.guildId, name, description, options);
          connection.registeredCommands.add(name);

          connection.ws.send(JSON.stringify({
            type: 'slash-command-registered',
            name
          }));

          console.log(`[Server] Registered slash command /${name} for ${connection.agentName}`);
        } catch (error: any) {
          console.error(`[Server] Failed to register slash command:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to register slash command: ${error.message}`
          }));
        }
        break;
      }

      case 'unregisterSlashCommand': {
        const { name } = msg;

        try {
          await this.unregisterSlashCommand(connection.guildId, name);
          connection.registeredCommands.delete(name);

          connection.ws.send(JSON.stringify({
            type: 'slash-command-unregistered',
            name
          }));

          console.log(`[Server] Unregistered slash command /${name} for ${connection.agentName}`);
        } catch (error: any) {
          console.error(`[Server] Failed to unregister slash command:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to unregister slash command: ${error.message}`
          }));
        }
        break;
      }

      case 'sendTyping': {
        const { channelId } = msg;

        try {
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || !channel.isTextBased()) {
            throw new Error('Channel not found or not a text channel');
          }

          await channel.sendTyping();
          console.log(`[Server] Sent typing indicator to ${channel.name}`);
        } catch (error: any) {
          console.error(`[Server] Failed to send typing indicator:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to send typing indicator: ${error.message}`
          }));
        }
        break;
      }

      case 'sendEmbed': {
        const { channelId, embed, buttons = [] } = msg;

        try {
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }

          // Build embed
          const embedBuilder = new EmbedBuilder()
            .setTitle(embed.title)
            .setDescription(embed.description)
            .setColor(embed.color || 0x5865F2);

          if (embed.fields) {
            embedBuilder.addFields(embed.fields);
          }

          // Build message payload
          const messagePayload: any = { embeds: [embedBuilder] };

          // Add buttons if provided
          if (buttons.length > 0) {
            const row = new ActionRowBuilder<ButtonBuilder>();
            for (const btn of buttons) {
              const button = new ButtonBuilder()
                .setCustomId(btn.customId)
                .setLabel(btn.label)
                .setStyle(this.getButtonStyle(btn.style));

              if (btn.emoji) {
                button.setEmoji(btn.emoji);
              }

              row.addComponents(button);
            }
            messagePayload.components = [row];
          }

          const sentMessage = await channel.send(messagePayload);
          console.log(`[Server] Sent embed to ${channel.name} with ${buttons.length} buttons`);

          // Send confirmation
          connection.ws.send(JSON.stringify({
            type: 'message_sent',
            channelId,
            messageId: sentMessage.id,
            timestamp: sentMessage.createdAt.toISOString()
          }));
        } catch (error: any) {
          console.error(`[Server] Failed to send embed:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to send embed: ${error.message}`
          }));
        }
        break;
      }

      case 'editMessage': {
        const { channelId, messageId, content, embed, buttons = [] } = msg;

        try {
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }

          const message = await channel.messages.fetch(messageId);
          if (!message) {
            throw new Error('Message not found');
          }

          // Build message payload
          const messagePayload: any = {};

          if (content !== undefined) {
            messagePayload.content = content;
          }

          if (embed) {
            const embedBuilder = new EmbedBuilder()
              .setTitle(embed.title)
              .setDescription(embed.description)
              .setColor(embed.color || 0x5865F2);

            if (embed.fields) {
              embedBuilder.addFields(embed.fields);
            }

            messagePayload.embeds = [embedBuilder];
          }

          // Add buttons if provided
          if (buttons.length > 0) {
            const row = new ActionRowBuilder<ButtonBuilder>();
            for (const btn of buttons) {
              const button = new ButtonBuilder()
                .setCustomId(btn.customId)
                .setLabel(btn.label)
                .setStyle(this.getButtonStyle(btn.style));

              if (btn.emoji) {
                button.setEmoji(btn.emoji);
              }

              row.addComponents(button);
            }
            messagePayload.components = [row];
          } else {
            // Clear buttons if none provided
            messagePayload.components = [];
          }

          await message.edit(messagePayload);
          console.log(`[Server] Edited message ${messageId} in ${channel.name}`);

          // Send confirmation
          connection.ws.send(JSON.stringify({
            type: 'message_edited',
            channelId,
            messageId,
            timestamp: new Date().toISOString()
          }));
        } catch (error: any) {
          console.error(`[Server] Failed to edit message:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to edit message: ${error.message}`
          }));
        }
        break;
      }

      case 'replyToInteraction': {
        const { interactionId, content, embed, ephemeral = false } = msg;

        try {
          const interaction = connection.pendingInteractions.get(interactionId);
          if (!interaction) {
            throw new Error('Interaction not found or expired');
          }

          const replyOptions: any = { ephemeral };

          if (content) {
            replyOptions.content = content;
          }

          if (embed) {
            const embedBuilder = new EmbedBuilder()
              .setTitle(embed.title)
              .setDescription(embed.description)
              .setColor(embed.color || 0x5865F2);

            if (embed.fields) {
              embedBuilder.addFields(embed.fields);
            }

            replyOptions.embeds = [embedBuilder];
          }

          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(replyOptions);
          } else {
            await interaction.reply(replyOptions);
          }

          // Clean up
          connection.pendingInteractions.delete(interactionId);

          console.log(`[Server] Replied to interaction ${interactionId}`);
        } catch (error: any) {
          console.error(`[Server] Failed to reply to interaction:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to reply to interaction: ${error.message}`
          }));
        }
        break;
      }
    }
  }

  private getButtonStyle(style: string): ButtonStyle {
    switch (style.toLowerCase()) {
      case 'primary':
      case 'blurple':
        return ButtonStyle.Primary;
      case 'secondary':
      case 'grey':
      case 'gray':
        return ButtonStyle.Secondary;
      case 'success':
      case 'green':
        return ButtonStyle.Success;
      case 'danger':
      case 'red':
        return ButtonStyle.Danger;
      case 'link':
        return ButtonStyle.Link;
      default:
        return ButtonStyle.Primary;
    }
  }

  private async registerSlashCommand(guildId: string, name: string, description: string, options: any[]): Promise<void> {
    if (!this.rest || !this.discord.user) {
      throw new Error('Discord client not ready');
    }

    console.log(`[Server] Registering slash command /${name} for guild ${guildId}, bot user ${this.discord.user.id}`);

    const command = new SlashCommandBuilder()
      .setName(name)
      .setDescription(description);

    // Add options
    for (const opt of options) {
      switch (opt.type.toLowerCase()) {
        case 'string':
          command.addStringOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'integer':
          command.addIntegerOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'boolean':
          command.addBooleanOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'user':
          command.addUserOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'channel':
          command.addChannelOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
      }
    }

    // Register command to guild (POST adds individual command without overwriting others)
    try {
      const route = Routes.applicationGuildCommands(this.discord.user.id, guildId);
      console.log(`[Server] POST to Discord API: ${route}`);
      const result = await this.rest.post(route, { body: command.toJSON() });
      console.log(`[Server] Successfully registered /${name}:`, result);
    } catch (error: any) {
      console.error(`[Server] Discord API error:`, {
        status: error.status,
        code: error.code,
        message: error.message,
        requestBody: error.requestBody
      });
      throw error;
    }
  }

  private async unregisterSlashCommand(guildId: string, name: string): Promise<void> {
    if (!this.rest || !this.discord.user) {
      return;
    }

    try {
      // Get all registered commands
      const commands: any = await this.rest.get(
        Routes.applicationGuildCommands(this.discord.user.id, guildId)
      );

      // Find and delete the command
      const command = commands.find((c: any) => c.name === name);
      if (command) {
        await this.rest.delete(
          Routes.applicationGuildCommand(this.discord.user.id, guildId, command.id)
        );
      }
    } catch (error) {
      console.error(`[Server] Error unregistering command ${name}:`, error);
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
    // Login to Discord FIRST (before starting servers)
    console.log('🔐 Logging into Discord...');
    await this.discord.login(botToken);

    // Wait for Discord to be fully ready
    if (!this.discord.isReady()) {
      await new Promise<void>((resolve) => {
        this.discord.once('ready', () => resolve());
      });
    }

    console.log(`✅ Discord bot ready as ${this.discord.user?.tag}`);

    // Initialize REST client for slash commands (after login)
    this.rest = new REST({ version: '10' }).setToken(botToken);

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
  }
}

export { CombinedDiscordAxonServer };
export type { AxonConnection };
