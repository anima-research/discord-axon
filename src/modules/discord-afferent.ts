/**
 * Discord Afferent - Manages WebSocket connection to Discord AXON server
 * 
 * This is the architecturally correct way to handle Discord in RETM:
 * - Afferent handles external input (WebSocket messages)
 * - Emits events when messages arrive
 * - Processes commands (join, leave, send) through command queue
 * - Does NOT touch VEIL state directly
 */

import type { IAxonEnvironmentV2 } from 'connectome-ts/src/axon/interfaces-v2';

interface DiscordConfig {
  serverUrl: string;
  guild: string;
  agent: string;
  botToken?: string;
  scrollbackLimit?: number;
}

interface DiscordCommand {
  type: 'join' | 'leave' | 'send' | 'registerSlashCommand' | 'unregisterSlashCommand' | 'sendTyping' | 'replyToInteraction';
  channelId?: string;
  message?: string;
  replyTo?: string;  // Message ID to reply to
  scrollback?: number;
  lastMessageId?: string;
  // Slash command params
  commandName?: string;
  description?: string;
  options?: any[];
  // Interaction params
  interactionId?: string;
  content?: string;
  embed?: any;
  ephemeral?: boolean;
}

// Export flag to signal this is an afferent module
export const afferents = ['DiscordAfferent'];

export function createModule(env: IAxonEnvironmentV2): any {
  const { BaseAfferent, WebSocket, persistent, external, persistable } = env;
  
  @persistable(1)
  class DiscordAfferent extends BaseAfferent<DiscordConfig, DiscordCommand> {
    // Bot token stored directly from params (not via @external since it comes from URL)
    private botToken?: string;

    // Runtime state only (rebuilt from VEIL on mount)
    private ws?: any;
    private reconnectTimeout?: any;
    private shouldReconnect = true;
    private connectionAttempts = 0;
    private processedMessagesCache = new Set<string>();
    private initialized = false;

    // Cache for frequently accessed state (rebuilt from component-state in VEIL)
    private joinedChannelsCache: string[] = [];
    private channelNamesCache: Record<string, string> = {};
    private lastReadCache: Record<string, string> = {};

    // Called by AxonLoader when parameters are provided
    async setConnectionParams(params: any): Promise<void> {
      console.log('[DiscordAfferent] Setting connection params:', params);

      // Store bot token from params
      if (params.token) {
        this.botToken = params.token;
        console.log('[DiscordAfferent] Bot token received from params');
      }

      // Create context for AXON-loaded afferents
      if (!this.context) {
        (this as any).context = {
          config: {
            serverUrl: params.host && params.path ? `ws://${params.host}${params.path}` : '',
            guild: params.guild || '',
            agent: params.agent || 'Connectome Agent',
            scrollbackLimit: 50
          },
          afferentId: 'discord-afferent',
          emit: (event: any) => {
            if (this.element) {
              this.element.emit(event);
            }
          },
          emitError: (error: any) => {
            console.error('[DiscordAfferent] Error:', error);
          }
        };
      }

      // Initialize and start immediately since we have everything we need
      if (!this.initialized && this.context && this.botToken) {
        console.log('[DiscordAfferent] Initializing and starting...');
        this.initialized = true;

        // Initialize and start the afferent
        await this.initialize(this.context);
        await this.start();
      } else {
        console.warn('[DiscordAfferent] Cannot initialize - missing context or token');
      }
    }
    
    protected async onInitialize(): Promise<void> {
      console.log('[DiscordAfferent] Initializing...');
      
      // Read state from VEIL component-state facet
      const componentState = this.getComponentState();
      
      // Populate caches from VEIL state
      this.joinedChannelsCache = componentState.joinedChannels || [];
      this.channelNamesCache = componentState.channelNames || {};
      this.lastReadCache = componentState.lastRead || {};
      
      console.log('[DiscordAfferent] Loaded from VEIL:', {
        joinedChannels: this.joinedChannelsCache.length,
        channelNames: Object.keys(this.channelNamesCache).length,
        lastRead: Object.keys(this.lastReadCache).length
      });
    }
    
    protected async onStart(): Promise<void> {
      console.log('[DiscordAfferent] Starting WebSocket connection...');
      await this.connect();
    }
    
    protected async onStop(): Promise<void> {
      console.log('[DiscordAfferent] Stopping...');
      this.shouldReconnect = false;
      
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
      
      if (this.ws) {
        this.ws.close(1000, 'Afferent stopping');
        this.ws = undefined;
      }
    }
    
    protected async onDestroyAfferent(): Promise<void> {
      console.log('[DiscordAfferent] Destroyed');
    }
    
    protected async onCommand(command: DiscordCommand): Promise<void> {
      console.log(`[DiscordAfferent] Processing command: ${command.type}`);

      if (!this.ws) {
        console.warn('[DiscordAfferent] Cannot process command - not connected');
        return;
      }

      switch (command.type) {
        case 'join':
          this.ws.send(JSON.stringify({
            type: 'join',
            channelId: command.channelId,
            scrollback: command.scrollback || 50,
            lastMessageId: command.lastMessageId || this.lastReadCache[command.channelId!]
          }));

          if (!this.joinedChannelsCache.includes(command.channelId!)) {
            this.joinedChannelsCache.push(command.channelId!);
            // Persist to VEIL (endotemporal evolution)
            this.emitFacet({
              id: `discord-join-${command.channelId}-${Date.now()}`,
              type: 'state-change',
              targetFacetIds: [`component-state:${this.getComponentId()}`],
              state: {
                changes: {
                  joinedChannels: {
                    old: this.joinedChannelsCache.slice(0, -1),
                    new: this.joinedChannelsCache
                  }
                }
              },
              ephemeral: true
            });
          }
          break;

        case 'leave':
          this.ws.send(JSON.stringify({
            type: 'leave',
            channelId: command.channelId
          }));

          this.joinedChannelsCache = this.joinedChannelsCache.filter(id => id !== command.channelId);
          break;

        case 'send':
          if (!command.message) {
            console.warn('[DiscordAfferent] Send command missing message');
            return;
          }

          this.ws.send(JSON.stringify({
            type: 'send',
            channelId: command.channelId,
            message: command.message,
            replyTo: command.replyTo  // Optional reply target
          }));
          break;

        case 'registerSlashCommand':
          if (!command.commandName || !command.description) {
            console.warn('[DiscordAfferent] registerSlashCommand missing required params');
            return;
          }

          this.ws.send(JSON.stringify({
            type: 'registerSlashCommand',
            name: command.commandName,
            description: command.description,
            options: command.options || []
          }));
          break;

        case 'unregisterSlashCommand':
          if (!command.commandName) {
            console.warn('[DiscordAfferent] unregisterSlashCommand missing commandName');
            return;
          }

          this.ws.send(JSON.stringify({
            type: 'unregisterSlashCommand',
            name: command.commandName
          }));
          break;

        case 'sendTyping':
          if (!command.channelId) {
            console.warn('[DiscordAfferent] sendTyping missing channelId');
            return;
          }

          this.ws.send(JSON.stringify({
            type: 'sendTyping',
            channelId: command.channelId
          }));
          break;

        case 'replyToInteraction':
          if (!command.interactionId) {
            console.warn('[DiscordAfferent] replyToInteraction missing interactionId');
            return;
          }

          this.ws.send(JSON.stringify({
            type: 'replyToInteraction',
            interactionId: command.interactionId,
            content: command.content,
            embed: command.embed,
            ephemeral: command.ephemeral || false
          }));
          break;
      }
    }
    
    // WebSocket connection management
    
    private async connect(): Promise<void> {
      if (!WebSocket) {
        console.error('[DiscordAfferent] WebSocket not available');
        return;
      }
      
      const serverUrl = this.context.config.serverUrl;
      console.log('[DiscordAfferent] Connecting to', serverUrl);
      
      try {
        this.ws = new WebSocket(serverUrl);
        
        this.ws.onopen = () => {
          console.log('[DiscordAfferent] WebSocket connected, authenticating...');
          const config = this.context.config;
          this.ws.send(JSON.stringify({
            type: 'auth',
            token: this.botToken,
            guild: config.guild || config.guildId,
            agent: config.agent || config.agentName
          }));
        };
        
        this.ws.onmessage = (event: any) => {
          try {
            const msg = JSON.parse(event.data);
            this.handleMessage(msg);
          } catch (error) {
            console.error('[DiscordAfferent] Failed to parse message:', error);
          }
        };
        
        this.ws.onerror = (error: any) => {
          console.error('[DiscordAfferent] WebSocket error:', error);
          this.handleError('connection', 'WebSocket error', error);
        };
        
        this.ws.onclose = (event: any) => {
          console.log('[DiscordAfferent] WebSocket closed:', event.code, event.reason);
          
          if (this.shouldReconnect && !event.wasClean && this.running) {
            this.scheduleReconnect();
          }
        };
      } catch (error: any) {
        console.error('[DiscordAfferent] Failed to connect:', error);
        this.handleError('fatal', 'Connection failed', error);
        this.scheduleReconnect();
      }
    }
    
    private handleMessage(msg: any): void {
      console.log('[DiscordAfferent] Received:', msg.type);
      
      switch (msg.type) {
        case 'authenticated':
          this.connectionAttempts = 0;
          
          const config = this.getComponentState();
          
          // Emit connection event
          this.emit({
            topic: 'discord:connected',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: {
              agentName: config.agent || config.agentName,
              guildId: config.guild || config.guildId,
              botUserId: msg.botUserId,
              reconnect: this.connectionAttempts > 1
            }
          });
          break;
          
        case 'history':
          this.handleHistory(msg);
          break;
          
        case 'message':
          this.handleLiveMessage(msg.payload);
          break;
          
        case 'messageUpdate':
          this.emit({
            topic: 'discord:messageUpdate',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: msg.payload
          });
          break;
          
        case 'messageDelete':
          this.emit({
            topic: 'discord:messageDelete',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: msg.payload
          });
          break;
          
        case 'joined':
          if (msg.channel?.id) {
            if (!this.joinedChannelsCache.includes(msg.channel.id)) {
              this.joinedChannelsCache.push(msg.channel.id);
            }
            if (msg.channel.name) {
              this.channelNamesCache[msg.channel.id] = msg.channel.name;
            }
          }
          
          this.emit({
            topic: 'discord:channel-joined',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: msg.channel
          });
          break;
          
        case 'left':
          this.joinedChannelsCache = this.joinedChannelsCache.filter(id => id !== msg.channelId);
          
          this.emit({
            topic: 'discord:channel-left',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: { channelId: msg.channelId }
          });
          break;
          
        case 'message_sent':
          // Update tracking
          if (msg.channelId && msg.messageId) {
            this.lastReadCache[msg.channelId] = msg.messageId;
            this.processedMessagesCache.add(msg.messageId);
          }
          break;

        case 'interaction:slash-command':
          this.emit({
            topic: 'discord:slash-command',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: msg.payload
          });
          break;

        case 'interaction:button-click':
          this.emit({
            topic: 'discord:button-click',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: msg.payload
          });
          break;

        case 'slash-command-registered':
          console.log('[DiscordAfferent] Slash command registered:', msg.name);
          break;

        case 'slash-command-unregistered':
          console.log('[DiscordAfferent] Slash command unregistered:', msg.name);
          break;

        case 'error':
          console.error('[DiscordAfferent] Server error:', msg.error);
          this.handleError('processing', 'Server error', msg.error);
          break;
      }
    }
    
    private handleHistory(msg: any): void {
      const { channelId, channelName, guildId, guildName, messages = [] } = msg;
      
      console.log(`[DiscordAfferent] Received history for ${channelName}: ${messages.length} messages`);
      
      // Update metadata cache
      if (channelName && channelId) {
        this.channelNamesCache[channelId] = channelName;
      }
      
      // Build message ID map for quick lookup
      const historyMessageIds = new Set(messages.map((m: any) => m.messageId));
      const historyByMessageId = new Map(messages.map((m: any) => [m.messageId, m]));
      
      // Detect offline edits and deletes by comparing to VEIL (if accessible)
      // Note: This requires access to VEIL state, which afferents don't have directly
      // We'll emit events that a Receptor can process to detect changes
      this.emit({
        topic: 'discord:history-sync',
        source: { elementId: this.element?.id || 'discord', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          channelId,
          channelName,
          messages: messages.map((m: any) => ({
            messageId: m.messageId,
            content: m.content,
            rawContent: m.rawContent,
            mentions: m.mentions,
            author: m.author,
            authorId: m.authorId,
            isBot: m.isBot
          }))
        }
      });
      
      // Filter out already-seen messages (using cache)
      const lastReadId = this.lastReadCache[channelId];
      let newMessages = messages;
      
      if (lastReadId) {
        const lastReadBigInt = BigInt(lastReadId);
        newMessages = messages.filter((m: any) => {
          try {
            return BigInt(m.messageId) > lastReadBigInt;
          } catch (e) {
            return false;
          }
        });
        
        console.log(`[DiscordAfferent] Filtered ${messages.length - newMessages.length} already-read messages`);
      }
      
      // Emit each new message as an event
      const streamId = this.buildStreamId(channelName, guildName);
      
      for (const message of newMessages) {
        this.emit({
          topic: 'discord:message',
          source: { elementId: this.element?.id || 'discord', elementPath: [] },
          timestamp: Date.now(),
          payload: {
            channelId: message.channelId,
            messageId: message.messageId,
            author: message.author,
            authorId: message.authorId,
            isBot: message.isBot,
            content: message.content,
            rawContent: message.rawContent,
            mentions: message.mentions,
            timestamp: message.timestamp,
            channelName,
            guildName,
            streamId,
            streamType: 'discord',
            isHistory: true
          }
        });
        
        this.processedMessagesCache.add(message.messageId);
      }
      
      // Update lastRead cache
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        this.lastReadCache[channelId] = lastMessage.messageId;
      }
      
      // Emit history complete event
      this.emit({
        topic: 'discord:history-complete',
        source: { elementId: this.element?.id || 'discord', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          channelId,
          channelName,
          messageCount: newMessages.length
        }
      });
    }
    
    private handleLiveMessage(msg: any): void {
      if (this.processedMessagesCache.has(msg.messageId)) {
        console.log(`[DiscordAfferent] Skipping duplicate message ${msg.messageId}`);
        return;
      }
      
      // Update metadata cache
      if (msg.channelName && msg.channelId) {
        this.channelNamesCache[msg.channelId] = msg.channelName;
      }
      
      // Build stream ID
      const streamId = this.buildStreamId(msg.channelName, msg.guildName);
      
      // Emit message event with all fields including mentions
      this.emit({
        topic: 'discord:message',
        source: { elementId: this.element?.id || 'discord', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          channelId: msg.channelId,
          messageId: msg.messageId,
          author: msg.author,
          authorId: msg.authorId,
          isBot: msg.isBot,
          content: msg.content, // Parsed content with human-readable mentions
          rawContent: msg.rawContent, // Original content with Discord IDs
          mentions: msg.mentions, // Structured mention metadata
          timestamp: msg.timestamp,
          channelName: msg.channelName,
          guildName: msg.guildName,
          streamId,
          streamType: 'discord'
        }
      });
      
      // Update tracking cache
      this.lastReadCache[msg.channelId] = msg.messageId;
      this.processedMessagesCache.add(msg.messageId);
    }
    
    private buildStreamId(channelName?: string, guildName?: string): string {
      if (channelName && guildName) {
        return `discord:${guildName}:#${channelName}`;
      } else if (channelName) {
        return `discord:#${channelName}`;
      }
      return 'discord:unknown';
    }
    
    private scheduleReconnect(): void {
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }
      
      const delay = Math.min(1000 * Math.pow(2, this.connectionAttempts), 30000);
      this.connectionAttempts++;
      
      console.log(`[DiscordAfferent] Reconnecting in ${delay}ms (attempt ${this.connectionAttempts})`);
      
      this.reconnectTimeout = setTimeout(() => {
        if (this.running) {
          this.connect();
        }
      }, delay);
    }
    
    // Public API for action invocation

    static actions = {
      'join': {
        description: 'Join a Discord channel',
        parameters: {
          channelId: { type: 'string', required: true }
        }
      },
      'leave': {
        description: 'Leave a Discord channel',
        parameters: {
          channelId: { type: 'string', required: true }
        }
      },
      'send': {
        description: 'Send a message to a channel',
        parameters: {
          channelId: { type: 'string', required: true },
          message: { type: 'string', required: true }
        }
      },
      'registerSlashCommand': {
        description: 'Register a slash command',
        parameters: {
          commandName: { type: 'string', required: true },
          description: { type: 'string', required: true },
          options: { type: 'array', required: false }
        }
      },
      'unregisterSlashCommand': {
        description: 'Unregister a slash command',
        parameters: {
          commandName: { type: 'string', required: true }
        }
      },
      'sendTyping': {
        description: 'Send typing indicator to a channel',
        parameters: {
          channelId: { type: 'string', required: true }
        }
      },
      'replyToInteraction': {
        description: 'Reply to a Discord interaction (slash command or button)',
        parameters: {
          interactionId: { type: 'string', required: true },
          content: { type: 'string', required: false },
          embed: { type: 'object', required: false },
          ephemeral: { type: 'boolean', required: false }
        }
      }
    };

    async join(params: { channelId: string }): Promise<void> {
      this.enqueueCommand({
        type: 'join',
        channelId: params.channelId
      });
    }

    async leave(params: { channelId: string }): Promise<void> {
      this.enqueueCommand({
        type: 'leave',
        channelId: params.channelId
      });
    }

    async send(params: { channelId: string; message: string; replyTo?: string }): Promise<void> {
      this.enqueueCommand({
        type: 'send',
        channelId: params.channelId,
        message: params.message,
        replyTo: params.replyTo
      });
    }

    async registerSlashCommand(params: { commandName: string; description: string; options?: any[] }): Promise<void> {
      this.enqueueCommand({
        type: 'registerSlashCommand',
        commandName: params.commandName,
        description: params.description,
        options: params.options
      });
    }

    async unregisterSlashCommand(params: { commandName: string }): Promise<void> {
      this.enqueueCommand({
        type: 'unregisterSlashCommand',
        commandName: params.commandName
      });
    }

    async sendTyping(params: { channelId: string }): Promise<void> {
      this.enqueueCommand({
        type: 'sendTyping',
        channelId: params.channelId
      });
    }

    async replyToInteraction(params: { interactionId: string; content?: string; embed?: any; ephemeral?: boolean }): Promise<void> {
      this.enqueueCommand({
        type: 'replyToInteraction',
        interactionId: params.interactionId,
        content: params.content,
        embed: params.embed,
        ephemeral: params.ephemeral
      });
    }

    // Provide clean serialization for logging
    toJSON() {
      return {
        type: 'DiscordAfferent',
        connected: !!this.ws,
        reconnecting: !!this.reconnectTimeout,
        joinedChannels: this.joinedChannelsCache.length,
        channelNames: Object.keys(this.channelNamesCache).length
      };
    }
  }

  // Return in RETM module format for AxonLoader
  return {
    afferents: { DiscordAfferent }
  };
}
