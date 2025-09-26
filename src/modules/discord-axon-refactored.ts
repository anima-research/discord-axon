/**
 * Discord AXON Component - Refactored for interface-based architecture
 * 
 * This component no longer imports Connectome internals directly.
 * Instead, it receives everything it needs through the environment.
 */

// Import types - these will be resolved at transpilation time
declare interface IInteractiveComponent {
  addOperation(operation: any): void;
  trackPropertyChange(propertyName: string, oldValue: any, newValue: any): void;
  setTrackedProperty<K extends keyof any>(key: K, value: any): void;
  addFacet(facetDef: any): void;
  updateState(facetId: string, updates: any, updateMode?: string): void;
  registerAction(name: string, handler: (params?: any) => Promise<void>): void;
  element: any;
}

declare interface ISpaceEvent<T = unknown> {
  topic: string;
  source: any;
  payload: T;
  timestamp: number;
}

declare interface IPersistentMetadata {
  propertyKey: string;
  version?: number;
}

declare interface IExternalMetadata {
  propertyKey: string;
  resourceId: string;
}

declare interface IAxonEnvironment {
  InteractiveComponent: abstract new() => IInteractiveComponent;
  persistent: (target: any, propertyKey: string) => void;
  external: (resourceId: string) => (target: any, propertyKey: string) => void;
  WebSocket?: any;
}

interface DiscordConnectionParams {
  host: string;
  path: string;
  token?: string;
  guild?: string;
  agent?: string;
}

interface DiscordMessage {
  channelId: string;
  channelName?: string;
  messageId: string;
  author: string;
  content: string;
  timestamp: string;
  guildId?: string;
  guildName?: string;
}

// Module factory function
export function createModule(env: IAxonEnvironment): typeof env.InteractiveComponent {
  const {
    InteractiveComponent,
    persistent,
    external,
    WebSocket
  } = env;
  
  class DiscordAxonComponent extends InteractiveComponent {
    // Connection parameters
    @persistent
    private serverUrl: string = '';
    
    @persistent
    private connectionParams: Record<string, any> = {};
    
    // Discord-specific state
    @persistent
    protected guildId: string = '';
    
    @persistent
    protected guildName: string = '';
    
    @persistent
    protected agentName: string = 'Connectome Agent';
    
    @persistent
    protected botUserId: string = '';
    
    // Bot token is external (not persisted for security)
    @external('secret:discord.token')
    protected botToken?: string;
    
    // Runtime state (not persisted - always starts as disconnected)
    private connectionState: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    
    @persistent
    private lastError?: string;
    
    @persistent
    private connectionAttempts: number = 0;
    
    @persistent
    protected joinedChannels: string[] = [];
    
    @persistent
    private channelNames: Record<string, string> = {}; // channelId -> channelName
    
    @persistent
    private lastRead: Record<string, string> = {};
    
    @persistent
    private scrollbackLimit: number = 50;
    
    private ws?: any; // WebSocket instance
    private reconnectTimeout?: any;
    private shouldReconnect: boolean = true;
    private processedMessages: Set<string> = new Set();
    private isFirstConnection: boolean = true;
    private shouldConnectOnNextFrame: boolean = false;
    private pendingMessages: any[] = [];
    
    // Track message IDs by channel for deletion detection
    @persistent
    private channelMessages: Record<string, string[]> = {};
    
    // Static metadata for persistence
    static persistentProperties: IPersistentMetadata[] = [
      { propertyKey: 'serverUrl' },
      { propertyKey: 'connectionParams' },
      { propertyKey: 'guildId' },
      { propertyKey: 'guildName' },
      { propertyKey: 'agentName' },
      { propertyKey: 'botUserId' },
      // connectionState is runtime-only and should not be persisted
      { propertyKey: 'lastError' },
      { propertyKey: 'connectionAttempts' },
      { propertyKey: 'joinedChannels' },
      { propertyKey: 'channelNames' },
      { propertyKey: 'lastRead' },
      { propertyKey: 'scrollbackLimit' },
      { propertyKey: 'channelMessages' }
    ];
    
    static externalResources: IExternalMetadata[] = [
      { propertyKey: 'botToken', resourceId: 'secret:discord.token' }
    ];
    
    // Declare available actions
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
    
    constructor() {
      super();
      
      // Register action handlers
      this.registerAction('join', this.join.bind(this));
      this.registerAction('leave', this.leave.bind(this));
      this.registerAction('send', this.send.bind(this));
    }
    
    // Called by AxonElement when parameters are provided
    setConnectionParams(params: DiscordConnectionParams): void {
      console.log('[Discord] Setting connection params:', params);
      
      this.connectionParams = params;
      
      if (params.host && params.path) {
        this.serverUrl = `ws://${params.host}${params.path}`;
      }
      
      if (params.guild) {
        this.guildId = params.guild;
      }
      
      if (params.agent) {
        this.agentName = params.agent;
      }
      
      // Token is handled separately via external injection
      
      console.log('[Discord] Params set - serverUrl:', this.serverUrl, 'botToken:', this.botToken ? 'set' : 'not set');
    }
    
    /**
     * Build a human-readable stream ID for Discord channels
     */
    protected buildStreamId(channelName?: string, guildName?: string, isDM: boolean = false): string {
      if (isDM && channelName) {
        // DMs use format: discord:@username
        return `discord:@${channelName}`;
      } else if (channelName && guildName) {
        // Channels use format: discord:ServerName:#channel-name
        return `discord:${guildName}:#${channelName}`;
      } else if (channelName) {
        // Fallback if no guild name
        return `discord:#${channelName}`;
      }
      // Ultimate fallback
      return 'discord:unknown';
    }
    
    async onMount(): Promise<void> {
      console.log('[Discord] Component mounted');
      
      // Subscribe to relevant events
      this.element.subscribe('frame:start');
      this.element.subscribe('frame:end'); 
      this.element.subscribe('element:action');
      
      // Subscribe to control panel events
      this.element.subscribe('discord:request-guilds');
      this.element.subscribe('discord:request-channels');
      this.element.subscribe('discord:join-channel');
      this.element.subscribe('discord:leave-channel');
    }
    
    async handleEvent(event: ISpaceEvent): Promise<void> {
      // No super.handleEvent() - IInteractiveComponent doesn't have this method
      
      if (event.topic === 'frame:start') {
        // Process any pending messages
        if (this.pendingMessages.length > 0) {
          console.log(`[Discord] Processing ${this.pendingMessages.length} pending messages in frame:start`);
          const messages = [...this.pendingMessages];
          this.pendingMessages = [];
          for (const msg of messages) {
            this.processAxonMessage(msg);
          }
        }
        
        // Handle deferred connection
        if (this.shouldConnectOnNextFrame) {
          this.shouldConnectOnNextFrame = false;
          await this.startConnection();
        }
      } else if (event.topic === 'discord:request-guilds') {
        await this.handleRequestGuilds();
      } else if (event.topic === 'discord:request-channels') {
        await this.handleRequestChannels(event.payload);
      } else if (event.topic === 'discord:join-channel') {
        await this.handleJoinChannel(event.payload);
      } else if (event.topic === 'discord:leave-channel') {
        await this.handleLeaveChannel(event.payload);
      }
    }
    
    onReferencesResolved(): void {
      console.log('🔌 Discord onReferencesResolved - token:', this.botToken ? 'SET' : 'NOT SET', 'serverUrl:', this.serverUrl);
      
      if (this.serverUrl && this.botToken) {
        console.log('🔌 Discord will connect on next frame now that references are resolved');
        this.shouldConnectOnNextFrame = true;
      }
    }
    
    private async startConnection(): Promise<void> {
      if (this.serverUrl && this.botToken) {
        console.log('[Discord] Starting connection on frame:start after references resolved');
        await this.connect();
      }
    }
    
    onFirstFrame(): void {
      console.log('[Discord] onFirstFrame - serverUrl:', this.serverUrl, 'botToken:', this.botToken ? 'set' : 'not set');
      
      // Inspect VEIL history to find last known message IDs
      this.inspectVEILHistory();
      
      if (this.serverUrl && this.botToken) {
        console.log('[Discord] Have params in onFirstFrame but waiting for references to be resolved');
      }
    }
    
    private inspectVEILHistory(): void {
      const space = this.element.space;
      if (!space) return;
      
      // Note: This would need access to VEIL state, which should also be injected
      // For now, we'll skip this functionality
      console.log('[Discord] VEIL history inspection skipped in refactored version');
    }
    
    private async connect(): Promise<void> {
      if (!WebSocket) {
        console.error('[Discord] WebSocket not available in environment');
        return;
      }
      
      if (this.connectionState === 'connecting' || this.connectionState === 'connected') {
        console.log('[Discord] Already connected or connecting');
        return;
      }
      
      console.log('[Discord] Connecting to', this.serverUrl);
      this.setConnectionState('connecting');
      
      try {
        this.ws = new WebSocket(this.serverUrl);
        
        this.ws.onopen = () => {
          console.log('[Discord] WebSocket connected, authenticating...');
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
            this.handleAxonMessage(msg);
          } catch (error) {
            console.error('[Discord] Failed to parse message:', error);
          }
        };
        
        this.ws.onerror = (error: any) => {
          console.error('[Discord] WebSocket error:', error);
          this.setConnectionState('error', 'WebSocket error');
        };
        
        this.ws.onclose = (event: any) => {
          console.log('[Discord] WebSocket closed:', event.code, event.reason);
          this.setConnectionState('disconnected', event.reason || 'Connection closed');
          
          if (this.shouldReconnect && !event.wasClean) {
            this.scheduleReconnect();
          }
        };
      } catch (error: any) {
        console.error('[Discord] Failed to connect:', error);
        this.setConnectionState('error', error.message);
        this.scheduleReconnect();
      }
    }
    
    private handleAxonMessage(msg: any): void {
      console.log('[Discord] Received message:', msg);
      
      // Check if we're in a frame
      const space = this.element?.space;
      const inFrame = space && (space as any).getCurrentFrame && (space as any).getCurrentFrame();
      
      if (!inFrame) {
        // Queue the message to be processed in the next frame
        console.log(`[Discord] Queueing message for next frame:`, msg.type);
        this.pendingMessages.push(msg);
        
        // Emit a dummy event to trigger frame processing
        this.element.emit({
          topic: 'discord:pending-messages',
          payload: { count: this.pendingMessages.length },
          timestamp: Date.now()
        });
        return;
      }
      
      this.processAxonMessage(msg);
    }
    
    private processAxonMessage(msg: any): void {
      switch (msg.type) {
        case 'authenticated':
          this.connectionAttempts = 0;
          this.setConnectionState('connected');
          console.log('[Discord] Processing authenticated message in frame');
          
          if (msg.botUserId) {
            this.botUserId = msg.botUserId;
            console.log('[Discord] Received bot user ID:', this.botUserId);
          }
          
          // Emit connected event
          console.log('[Discord] Emitting discord:connected event');
          this.element.emit({
            topic: 'discord:connected',
            payload: {
              agentName: this.agentName,
              guildId: this.guildId,
              reconnect: this.connectionAttempts > 1,
              botUserId: this.botUserId
            },
            timestamp: Date.now()
          });
          
          break;
          
        case 'history':
          this.handleHistoryMessage(msg);
          break;
          
        case 'message':
          this.handleLiveMessage(msg.payload);
          break;
          
        case 'message_sent':
          this.handleMessageSent(msg);
          break;
          
        case 'messageUpdate':
          this.handleMessageUpdate(msg.payload);
          break;
          
        case 'messageDelete':
          this.handleMessageDelete(msg.payload);
          break;
          
        case 'error':
          console.error('[Discord] Server error:', msg.error);
          this.setConnectionState('error', msg.error);
          break;
          
        case 'guilds':
          console.log('[Discord] Received guilds list:', msg.guilds);
          this.element.emit({
            topic: 'discord:guilds-listed',
            payload: msg.guilds || [],
            timestamp: Date.now()
          });
          break;
          
        case 'channels':
          console.log('[Discord] Received channels list:', msg.channels);
          this.element.emit({
            topic: 'discord:channels-listed',
            payload: {
              guildId: msg.guildId,
              channels: msg.channels || []
            },
            timestamp: Date.now()
          });
          break;
          
        case 'joined':
          console.log('[Discord] Joined channel:', msg.channel);
          if (!this.joinedChannels.includes(msg.channel.id)) {
            this.joinedChannels.push(msg.channel.id);
          }
          // Store channel name for later use
          if (msg.channel.name && msg.channel.id) {
            this.channelNames[msg.channel.id] = msg.channel.name;
          }
          this.element.emit({
            topic: 'discord:channel-joined',
            payload: msg.channel,
            timestamp: Date.now()
          });
          break;
          
        case 'left':
          console.log('[Discord] Left channel:', msg.channelId);
          this.joinedChannels = this.joinedChannels.filter(id => id !== msg.channelId);
          this.element.emit({
            topic: 'discord:channel-left',
            payload: msg.channelId,
            timestamp: Date.now()
          });
          break;
          
        default:
          console.warn('[Discord] Unknown message type:', msg.type);
      }
    }
    
    private handleHistoryMessage(msg: any): void {
      const channelId = msg.channelId;
      const channelName = msg.channelName;
      const guildId = msg.guildId;
      const guildName = msg.guildName;
      let messages = msg.messages || [];
      
      console.log(`[Discord] Received history for channel ${channelName} (${channelId}): ${messages.length} messages`);
      
      // Update guild name if provided
      if (guildName && guildId === this.guildId) {
        this.guildName = guildName;
      }
      
      // Store channel name for later use
      if (channelName && channelId) {
        this.channelNames[channelId] = channelName;
      }
      
      // Detect deleted messages (only if we have existing messages tracked)
      if (this.channelMessages[channelId] && this.channelMessages[channelId].length > 0) {
        const receivedMessageIds = new Set(messages.map((m: any) => m.messageId));
        const deletedMessageIds = this.channelMessages[channelId].filter(id => !receivedMessageIds.has(id));
        
        if (deletedMessageIds.length > 0) {
          console.log(`[Discord] Detected ${deletedMessageIds.length} deleted messages in channel ${channelId}`);
          
          // Mark deleted messages
          for (const messageId of deletedMessageIds) {
            const facetId = `discord-msg-${messageId}`;
            const streamId = this.buildStreamId(channelName, guildName || this.guildName);
            
            // Emit delete event for each deleted message
            this.element.emit({
              topic: 'discord:messageDelete',
              payload: {
                channelId,
                messageId,
                timestamp: new Date().toISOString(),
                guildId: this.guildId,
                guildName: guildName || this.guildName,
                channelName,
                streamId,
                streamType: 'discord',
                facetId,
                detectedOnReconnect: true
              },
              timestamp: Date.now()
            });
            
            // Update the facet to mark as deleted
            this.updateState(facetId, {
              attributes: {
                deleted: true,
                deletedAt: new Date().toISOString(),
                detectedOnReconnect: true
              }
            });
          }
          
          // Update our tracking to remove deleted messages
          this.channelMessages[channelId] = this.channelMessages[channelId].filter(id => receivedMessageIds.has(id));
        }
      }
      
      // Filter out messages we've already seen
      const lastReadId = this.lastRead[channelId];
      if (lastReadId && messages.length > 0) {
        const lastReadBigInt = BigInt(lastReadId);
        const originalCount = messages.length;
        
        // Filter to only keep messages newer than lastRead
        messages = messages.filter((m: any) => {
          try {
            return BigInt(m.messageId) > lastReadBigInt;
          } catch (e) {
            console.warn(`[Discord] Invalid message ID: ${m.messageId}`);
            return false;
          }
        });
        
        if (messages.length < originalCount) {
          console.log(`[Discord] Filtered out ${originalCount - messages.length} already-read messages (older than ${lastReadId}), keeping ${messages.length} new messages`);
        } else {
          console.log(`[Discord] No messages filtered - all ${messages.length} messages are new (newer than ${lastReadId})`);
        }
      }
      
      // Only emit history event if there are actually new messages
      if (messages.length > 0) {
        // Emit the history as a single event
        this.element.emit({
          topic: 'discord:history-received',
          payload: {
            channelId,
            channelName,
            messages
          },
          timestamp: Date.now()
        });
        
        // Add a history event facet
        this.addFacet({
          id: `discord-history-${channelId}-${Date.now()}`,
          type: 'event',
          content: `Channel #${channelName} history (${messages.length} new messages)`,
          displayName: 'channel-history',
          attributes: {
            channelId,
            channelName,
            messageCount: messages.length,
            guildId: this.guildId
          },
          children: messages.map((message: DiscordMessage) => ({
          id: `discord-msg-${message.messageId}`,
          type: 'event',
          displayName: 'discord-message',
          content: `${message.author}: ${message.content}`,
          attributes: {
            channelId: message.channelId,
            messageId: message.messageId,
            author: message.author,
            content: message.content,
            timestamp: message.timestamp,
            guildId: this.guildId
          }
        }))
        });
      }
      
      // Update last read for the channel (after filtering)
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        this.lastRead[channelId] = lastMessage.messageId;
        console.log(`[Discord] Updated lastRead for ${channelId} to ${lastMessage.messageId}`);
        
        // Check for deleted messages if we have tracked messages for this channel
        if (this.channelMessages[channelId] && this.channelMessages[channelId].length > 0) {
          const receivedMessageIds = new Set(messages.map((m: DiscordMessage) => m.messageId));
          const deletedMessages = this.channelMessages[channelId].filter(id => !receivedMessageIds.has(id));
          
          if (deletedMessages.length > 0) {
            console.log(`[Discord] Detected ${deletedMessages.length} deleted messages in channel ${channelId}`);
            
            // Mark deleted messages
            for (const messageId of deletedMessages) {
              const facetId = `discord-msg-${messageId}`;
              // Emit deletion event
              this.element.emit({
                topic: 'discord:messageDelete',
                payload: {
                  messageId,
                  channelId,
                  timestamp: new Date().toISOString()
                }
              });
            }
          }
        }
        
        // Update tracked message IDs
        if (!this.channelMessages[channelId]) {
          this.channelMessages[channelId] = [];
        }
        this.channelMessages[channelId] = messages.map((m: DiscordMessage) => m.messageId);
      }
    }
    
    private handleLiveMessage(msg: DiscordMessage): void {
      if (this.processedMessages.has(msg.messageId)) {
        console.log(`[Discord] Skipping duplicate message ${msg.messageId}`);
        return;
      }
      
      // Don't add to processedMessages here - let the chat component handle its own tracking
      // this.processedMessages.add(msg.messageId);
      
      // Update guild name if provided
      if (msg.guildName && msg.guildId === this.guildId) {
        this.guildName = msg.guildName;
      }
      
      // Store channel name for later use
      if (msg.channelName && msg.channelId) {
        this.channelNames[msg.channelId] = msg.channelName;
      }
      
      // Build stream ID
      const streamId = this.buildStreamId(msg.channelName, msg.guildName || this.guildName);
      
      // Emit message event with stream info
      this.element.emit({
        topic: 'discord:message',
        payload: {
          ...msg,
          streamId,
          streamType: 'discord'
        },
        timestamp: Date.now()
      });
      
      // Add message facet
      this.addFacet({
        id: `discord-msg-${msg.messageId}`,
        type: 'event',
        displayName: 'discord-message',
        content: `${msg.author}: ${msg.content}`,
        attributes: {
          channelId: msg.channelId,
          channelName: msg.channelName,
          messageId: msg.messageId,
          author: msg.author,
          content: msg.content,
          timestamp: msg.timestamp,
          guildId: this.guildId,
          guildName: msg.guildName || this.guildName,
          streamId,
          streamType: 'discord'
        }
      });
      
      // Track message ID for this channel
      if (!this.channelMessages[msg.channelId]) {
        this.channelMessages[msg.channelId] = [];
      }
      this.channelMessages[msg.channelId].push(msg.messageId);
      
      // Update last read
      this.lastRead[msg.channelId] = msg.messageId;
    }
    
    private handleMessageSent(msg: any): void {
      const { channelId, messageId, content, timestamp } = msg;
      
      console.log(`[Discord] Message sent confirmation - Channel: ${channelId}, ID: ${messageId}`);
      
      // Update lastRead to include our sent message
      this.lastRead[channelId] = messageId;
      console.log(`[Discord] Updated lastRead for ${channelId} to ${messageId} (our message)`);
      
      // Add to processed messages so we don't respond to our own message if we see it later
      this.processedMessages.add(messageId);
    }
    
    private handleMessageUpdate(msg: any): void {
      const { channelId, messageId, content, oldContent, author, timestamp } = msg;
      
      console.log(`[Discord] Message updated - ID: ${messageId}, Author: ${author}`);
      
      const facetId = `discord-msg-${messageId}`;
      const streamId = this.buildStreamId(msg.channelName, msg.guildName || this.guildName);
      
      // Emit update event
      this.element.emit({
        topic: 'discord:messageUpdate',
        payload: {
          ...msg,
          streamId,
          streamType: 'discord',
          facetId
        },
        timestamp: Date.now()
      });
      
      // Update the facet using the changeFacet operation
      this.addOperation({
        type: 'changeFacet',
        facetId,
        updates: {
          content: `${author}: ${content}`,
          attributes: {
            content,
            originalContent: oldContent,
            edited: true,
            editedAt: timestamp
          }
        }
      });
    }
    
    private handleMessageDelete(msg: any): void {
      const { channelId, messageId, author, timestamp } = msg;
      
      console.log(`[Discord] Message deleted - ID: ${messageId}, Author: ${author || 'unknown'}`);
      
      const facetId = `discord-msg-${messageId}`;
      const streamId = this.buildStreamId(msg.channelName, msg.guildName || this.guildName);
      
      // Emit delete event
      this.element.emit({
        topic: 'discord:messageDelete',
        payload: {
          ...msg,
          streamId,
          streamType: 'discord',
          facetId
        },
        timestamp: Date.now()
      });
      
      // Update the facet to mark as deleted rather than removing it
      // This preserves history while indicating the message is no longer visible
        this.addOperation({
        type: 'changeFacet',
        facetId,
        updates: {
          attributes: {
            deleted: true,
            deletedAt: timestamp
          }
        }
      });
      
      // Remove from channel messages tracking
      if (this.channelMessages[channelId]) {
        const index = this.channelMessages[channelId].indexOf(messageId);
        if (index > -1) {
          this.channelMessages[channelId].splice(index, 1);
        }
      }
    }
    
  private setConnectionState(state: typeof this.connectionState, error?: string): void {
    this.connectionState = state;
    if (error) {
      this.lastError = error;
    }
    
    // Only update VEIL state if we're in a frame
    const space = this.element?.space;
    if (space && (space as any).getCurrentFrame && (space as any).getCurrentFrame()) {
      // Update or create connection state facet
      this.updateState('discord-connection', {
        content: `Discord: ${state}${error ? ` - ${error}` : ''}`,
        attributes: {
          state,
          error,
          serverUrl: this.serverUrl,
          attempts: this.connectionAttempts
        }
      });
    }
  }
    
    private scheduleReconnect(): void {
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }
      
      const delay = Math.min(1000 * Math.pow(2, this.connectionAttempts), 30000);
      this.connectionAttempts++;
      
      console.log(`[Discord] Reconnecting in ${delay}ms (attempt ${this.connectionAttempts})`);
      
      this.reconnectTimeout = setTimeout(() => {
        this.connect();
      }, delay);
    }
    
    // Action handlers
    async join(params: { channelId: string }): Promise<void> {
      const { channelId } = params;
      
      if (!this.ws || this.connectionState !== 'connected') {
        throw new Error('Not connected to Discord');
      }
      
      console.log(`[Discord] Joining channel ${channelId}`);
      
      this.ws.send(JSON.stringify({
        type: 'join',
        channelId,
        scrollback: this.scrollbackLimit,
        lastMessageId: this.lastRead[channelId]
      }));
      
      if (!this.joinedChannels.includes(channelId)) {
        this.joinedChannels.push(channelId);
      }
      
      // Add join event
      this.addFacet({
        id: `discord-join-${channelId}-${Date.now()}`,
        type: 'event',
        displayName: 'channel-join',
        content: `Joined channel ${channelId}`,
        attributes: { channelId }
      });
    }
    
    async leave(params: { channelId: string }): Promise<void> {
      const { channelId } = params;
      
      if (!this.ws || this.connectionState !== 'connected') {
        throw new Error('Not connected to Discord');
      }
      
      console.log(`[Discord] Leaving channel ${channelId}`);
      
      this.ws.send(JSON.stringify({
        type: 'leave',
        channelId
      }));
      
      this.joinedChannels = this.joinedChannels.filter(id => id !== channelId);
      
      // Add leave event
      this.addFacet({
        id: `discord-leave-${channelId}-${Date.now()}`,
        type: 'event',
        displayName: 'channel-leave',
        content: `Left channel ${channelId}`,
        attributes: { channelId }
      });
    }
    
    async send(params: { channelId: string; message: string }): Promise<void> {
      const { channelId, message } = params;
      
      if (!this.ws || this.connectionState !== 'connected') {
        throw new Error('Not connected to Discord');
      }
      
      console.log(`[Discord] Sending message to ${channelId}: ${message}`);
      
      this.ws.send(JSON.stringify({
        type: 'send',
        channelId,
        message
      }));
      
      // Note: We don't create an action facet here because if this was triggered
      // by an agent's speak operation, there's already a speech facet for it.
      // Creating another facet would be redundant noise in the VEIL state.
    }
    
    // Control panel handlers
    private async handleRequestGuilds(): Promise<void> {
      console.log('[Discord] Requesting guilds list');
      
      if (this.connectionState !== 'connected') {
        console.warn('[Discord] Cannot request guilds - not connected');
        return;
      }
      
      this.ws?.send(JSON.stringify({
        type: 'listGuilds'
      }));
    }
    
    private async handleRequestChannels(payload: any): Promise<void> {
      console.log('[Discord] Requesting channels for guild:', payload);
      
      if (this.connectionState !== 'connected') {
        console.warn('[Discord] Cannot request channels - not connected');
        return;
      }
      
      const guildId = payload?.guildId || this.guildId;
      if (!guildId) {
        console.warn('[Discord] No guild ID specified for channel request');
        return;
      }
      
      this.ws?.send(JSON.stringify({
        type: 'listChannels',
        guildId
      }));
    }
    
    private async handleJoinChannel(payload: any): Promise<void> {
      console.log('[Discord] Joining channel:', payload);
      
      if (this.connectionState !== 'connected') {
        console.warn('[Discord] Cannot join channel - not connected');
        return;
      }
      
      const channelId = payload?.channelId;
      if (!channelId) {
        console.warn('[Discord] No channel ID specified for join request');
        return;
      }
      
      this.ws?.send(JSON.stringify({
        type: 'join',
        channelId
      }));
    }
    
    private async handleLeaveChannel(payload: any): Promise<void> {
      console.log('[Discord] Leaving channel:', payload);
      
      if (this.connectionState !== 'connected') {
        console.warn('[Discord] Cannot leave channel - not connected');
        return;
      }
      
      const channelId = payload?.channelId;
      if (!channelId) {
        console.warn('[Discord] No channel ID specified for leave request');
        return;
      }
      
      this.ws?.send(JSON.stringify({
        type: 'leave',
        channelId
      }));
    }
    
    async onUnmount(): Promise<void> {
      console.log('[Discord] Component unmounting');
      
      this.shouldReconnect = false;
      
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
      
      if (this.ws) {
        this.ws.close(1000, 'Component unmounting');
        this.ws = undefined;
      }
      
      this.setConnectionState('disconnected', 'Component unmounted');
    }
  }
  
  return DiscordAxonComponent;
}
