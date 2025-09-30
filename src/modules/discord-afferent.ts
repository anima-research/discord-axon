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
  type: 'join' | 'leave' | 'send';
  channelId: string;
  message?: string;
  scrollback?: number;
  lastMessageId?: string;
}

// Export flag to signal this is an afferent module
export const afferents = ['DiscordAfferent'];

export function createModule(env: IAxonEnvironmentV2): any {
  const { BaseAfferent, WebSocket, persistent, external, persistable } = env;
  
  @persistable(1)
  class DiscordAfferent extends BaseAfferent<DiscordConfig, DiscordCommand> {
    @external('secret:discord.token')
    private botToken?: string;
    
    @persistent
    private guildId: string = '';
    
    @persistent
    private guildName: string = '';
    
    @persistent
    private agentName: string = 'Connectome Agent';
    
    @persistent
    private botUserId: string = '';
    
    @persistent
    private joinedChannels: string[] = [];
    
    @persistent
    private channelNames: Record<string, string> = {}; // channelId -> channelName
    
    @persistent
    private lastRead: Record<string, string> = {};
    
    private ws?: any;
    private reconnectTimeout?: any;
    private shouldReconnect = true;
    private connectionAttempts = 0;
    private processedMessages = new Set<string>();
    private initialized = false;
    
    // Called by AxonLoader when parameters are provided
    setConnectionParams(params: any): void {
      console.log('[DiscordAfferent] Setting connection params:', params);
      
      // Store params for later initialization
      if (!this.context) {
        // Create a basic context for AXON-loaded afferents
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
    }
    
    // Called after external resources are resolved
    async onReferencesResolved(): Promise<void> {
      console.log('[DiscordAfferent] onReferencesResolved - token:', this.botToken ? 'SET' : 'NOT SET');
      
      if (!this.initialized && this.context && this.botToken) {
        console.log('[DiscordAfferent] Initializing and starting...');
        this.initialized = true;
        
        // Initialize and start the afferent
        await this.initialize(this.context);
        await this.start();
      }
    }
    
    protected async onInitialize(): Promise<void> {
      console.log('[DiscordAfferent] Initializing...');
      
      // Set config from context
      this.guildId = this.context.config.guild;
      this.agentName = this.context.config.agent;
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
            lastMessageId: command.lastMessageId || this.lastRead[command.channelId]
          }));
          
          if (!this.joinedChannels.includes(command.channelId)) {
            this.joinedChannels.push(command.channelId);
          }
          break;
          
        case 'leave':
          this.ws.send(JSON.stringify({
            type: 'leave',
            channelId: command.channelId
          }));
          
          this.joinedChannels = this.joinedChannels.filter(id => id !== command.channelId);
          break;
          
        case 'send':
          if (!command.message) {
            console.warn('[DiscordAfferent] Send command missing message');
            return;
          }
          
          this.ws.send(JSON.stringify({
            type: 'send',
            channelId: command.channelId,
            message: command.message
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
          this.ws.send(JSON.stringify({
            type: 'auth',
            token: this.botToken,
            guild: this.guildId,
            agent: this.agentName
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
          
          if (msg.botUserId) {
            this.botUserId = msg.botUserId;
          }
          
          // Emit connection event
          this.emit({
            topic: 'discord:connected',
            source: { elementId: this.element?.id || 'discord', elementPath: [] },
            timestamp: Date.now(),
            payload: {
              agentName: this.agentName,
              guildId: this.guildId,
              botUserId: this.botUserId,
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
            if (!this.joinedChannels.includes(msg.channel.id)) {
              this.joinedChannels.push(msg.channel.id);
            }
            if (msg.channel.name) {
              this.channelNames[msg.channel.id] = msg.channel.name;
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
          this.joinedChannels = this.joinedChannels.filter(id => id !== msg.channelId);
          
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
            this.lastRead[msg.channelId] = msg.messageId;
            this.processedMessages.add(msg.messageId);
          }
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
      
      // Update metadata
      if (guildName && guildId === this.guildId) {
        this.guildName = guildName;
      }
      
      if (channelName && channelId) {
        this.channelNames[channelId] = channelName;
      }
      
      // Filter out already-seen messages
      const lastReadId = this.lastRead[channelId];
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
      
      // Emit each message as an event
      const streamId = this.buildStreamId(channelName, guildName);
      
      for (const message of newMessages) {
        this.emit({
          topic: 'discord:message',
          source: { elementId: this.element?.id || 'discord', elementPath: [] },
          timestamp: Date.now(),
          payload: {
            ...message,
            streamId,
            streamType: 'discord',
            isHistory: true
          }
        });
        
        this.processedMessages.add(message.messageId);
      }
      
      // Update lastRead
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        this.lastRead[channelId] = lastMessage.messageId;
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
      if (this.processedMessages.has(msg.messageId)) {
        console.log(`[DiscordAfferent] Skipping duplicate message ${msg.messageId}`);
        return;
      }
      
      // Update metadata
      if (msg.guildName && msg.guildId === this.guildId) {
        this.guildName = msg.guildName;
      }
      
      if (msg.channelName && msg.channelId) {
        this.channelNames[msg.channelId] = msg.channelName;
      }
      
      // Build stream ID
      const streamId = this.buildStreamId(msg.channelName, msg.guildName);
      
      // Emit message event
      this.emit({
        topic: 'discord:message',
        source: { elementId: this.element?.id || 'discord', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          ...msg,
          streamId,
          streamType: 'discord'
        }
      });
      
      // Update tracking
      this.lastRead[msg.channelId] = msg.messageId;
      this.processedMessages.add(msg.messageId);
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
    
    async send(params: { channelId: string; message: string }): Promise<void> {
      this.enqueueCommand({
        type: 'send',
        channelId: params.channelId,
        message: params.message
      });
    }
    
    static persistentProperties = [
      { propertyKey: 'guildId' },
      { propertyKey: 'guildName' },
      { propertyKey: 'agentName' },
      { propertyKey: 'botUserId' },
      { propertyKey: 'joinedChannels' },
      { propertyKey: 'channelNames' },
      { propertyKey: 'lastRead' }
    ];
    
    static externalResources = [
      { propertyKey: 'botToken', resourceId: 'secret:discord.token' }
    ];
  }
  
  return DiscordAfferent;
}
