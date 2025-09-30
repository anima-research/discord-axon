/**
 * Discord AXON Component - Refactored for interface-based architecture
 * 
 * This component no longer imports Connectome internals directly.
 * Instead, it receives everything it needs through the environment.
 */

// Import shared AXON types from the centralized package
import type { 
  IInteractiveComponent, 
  ISpaceEvent, 
  IPersistentMetadata, 
  IExternalMetadata, 
  IAxonEnvironment 
} from '@connectome/axon-interfaces';

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

    private resolveFacetEntries(facets: unknown): Array<[string, any]> {
      if (facets instanceof Map) {
        return Array.from(facets.entries());
      }
      if (facets && typeof facets === 'object') {
        return Object.entries(facets as Record<string, any>);
      }
      return [];
    }

    private extractFacetData(facet: any): Record<string, any> | undefined {
      if (!facet || typeof facet !== 'object') {
        return undefined;
      }
      const state = (facet as any).state;
      if (state && typeof state === 'object') {
        if (state.metadata && typeof state.metadata === 'object') {
          return state.metadata as Record<string, any>;
        }
        return state as Record<string, any>;
      }
      if (facet.attributes && typeof facet.attributes === 'object') {
        return facet.attributes as Record<string, any>;
      }
      return undefined;
    }

    
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
      { propertyKey: 'scrollbackLimit' }
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
      // frame:end removed for V2 compatibility
      this.element.subscribe('element:action');
      
      // Subscribe to control panel events
      this.element.subscribe('discord:request-guilds');
      this.element.subscribe('discord:request-channels');
      this.element.subscribe('discord:join-channel');
      this.element.subscribe('discord:leave-channel');
    }
    
    async handleEvent(event: ISpaceEvent): Promise<void> {
      // Note: In RETM architecture, handleEvent is not called for subscribed events
      // This method is kept for compatibility but may not be invoked
      console.log(`[Discord] handleEvent called with topic: ${event.topic}`);
      
      if (event.topic === 'discord:request-guilds') {
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
      
      if (this.serverUrl && this.botToken && this.connectionState === 'disconnected') {
        // In RETM architecture, directly trigger connection instead of waiting for frame:start
        console.log('🔌 Discord connecting immediately after references resolved');
        this.connect().catch(error => {
          console.error('[Discord] Failed to connect:', error);
        });
      }
    }
    
    private async startConnection(): Promise<void> {
      if (this.serverUrl && this.botToken) {
        console.log('[Discord] Starting connection after references resolved');
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
      
      // In RETM architecture, process messages immediately
      // The component will emit events as needed
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
      
      // Additional deduplication: Check if messages already exist in VEIL
      console.log(`[Discord] Deduplication check: Checking ${messages.length} messages against VEIL state`);
      const veilState = this.element?.space?.veilState?.getState();
      console.log(`[Discord] VEIL state available: ${!!veilState}, element available: ${!!this.element}, space available: ${!!this.element?.space}`);
      if (veilState && messages.length > 0) {
        const originalCount = messages.length;
        
        // Get all existing message IDs from VEIL for this channel
        const existingMessageIds = new Set<string>();
        const facetEntries = this.resolveFacetEntries(veilState.facets);
        console.log(`[Discord] VEIL facets available: ${facetEntries.length}`);

        for (const [facetId, facet] of facetEntries) {
          const metadata = this.extractFacetData(facet);
          if (
            metadata &&
            facetId.startsWith('discord-msg-') &&
            metadata.channelId === channelId &&
            metadata.messageId
          ) {
            existingMessageIds.add(metadata.messageId);
          }
        }

        // Also check in any existing history event children
        for (const [, facet] of facetEntries) {
          const metadata = this.extractFacetData(facet);
          if (!metadata || metadata.channelId !== channelId) {
            continue;
          }

          const children = (facet as any).children;
          if (!Array.isArray(children)) {
            continue;
          }

          for (const child of children) {
            const childMetadata = this.extractFacetData(child) ?? (child?.metadata as Record<string, any> | undefined);
            if (childMetadata?.messageId) {
              existingMessageIds.add(childMetadata.messageId);
            }
          }
        }
        
        if (existingMessageIds.size > 0) {
          // Filter out messages that already exist in VEIL
          messages = messages.filter((m: DiscordMessage) => !existingMessageIds.has(m.messageId));
          
          const deduped = originalCount - messages.length;
          if (deduped > 0) {
            console.log(`[Discord] Deduplication: Filtered out ${deduped} messages already in VEIL, keeping ${messages.length} truly new messages`);
          }
        }
      }
      
      // Only emit history event if there are actually new messages
      if (messages.length > 0) {
        console.log(`[Discord] Emitting ${messages.length} history messages as individual events`);
        
        // Emit each history message as a discord:message event
        // The DiscordMessageReceptor will convert them to facets
        for (const message of messages) {
          const streamId = this.buildStreamId(channelName, guildName || this.guildName);
          this.element.emit({
            topic: 'discord:message',
            payload: {
              ...message,
              streamId,
              streamType: 'discord',
              isHistory: true  // Flag to avoid activation for history messages
            },
            timestamp: Date.now()
          });
          
          // Mark as processed
          this.processedMessages.add(message.messageId);
        }
        
        // Emit summary event
        this.element.emit({
          topic: 'discord:history-received',
          payload: {
            channelId,
            channelName,
            messageCount: messages.length
          },
          timestamp: Date.now()
        });
      } else {
        console.log(`[Discord] No new messages to add after deduplication`);
      }
      
      // Update last read for the channel based on original messages from Discord
      // (before any filtering) to ensure we track the actual last message
      if (msg.messages && msg.messages.length > 0) {
        const originalMessages = msg.messages;
        const lastMessage = originalMessages[originalMessages.length - 1];
        this.lastRead[channelId] = lastMessage.messageId;
        console.log(`[Discord] Updated lastRead for ${channelId} to ${lastMessage.messageId}`);
      }
      
      // Check for deleted messages by comparing with existing facets in VEIL
      if (messages.length > 0) {
        const veilState = this.element?.space?.veilState?.getState();
        if (veilState) {
          const receivedMessageIds = new Set(messages.map((m: DiscordMessage) => m.messageId));
          const facetEntries = this.resolveFacetEntries(veilState.facets);
          
          console.log(`[Discord] Checking for deleted messages in channel ${channelId}`);
          console.log(`[Discord] Received ${messages.length} messages from history`);
          console.log(`[Discord] Total facets in VEIL: ${facetEntries.length}`);
          
          // Find all message facets for this channel that aren't deleted
          const existingMessageIds: string[] = [];
          for (const [facetId, facet] of facetEntries) {
            const metadata = this.extractFacetData(facet);
            if (
              metadata &&
              facetId.startsWith('discord-msg-') &&
              metadata.channelId === channelId &&
              !metadata.deleted
            ) {
              const messageId = metadata.messageId;
              if (messageId) {
                existingMessageIds.push(messageId);
              }
            }
          }
          
          console.log(`[Discord] Found ${existingMessageIds.length} existing messages in VEIL for this channel`);
          console.log(`[Discord] Existing message IDs:`, existingMessageIds);
          
          // Find messages that exist in VEIL but not in the received history
          const deletedMessages = existingMessageIds.filter(id => !receivedMessageIds.has(id));
          
          if (deletedMessages.length > 0) {
            console.log(`[Discord] Detected ${deletedMessages.length} deleted messages in channel ${channelId}: ${deletedMessages.join(', ')}`);
            
            // Emit deletion events for each deleted message
            for (const messageId of deletedMessages) {
              this.element.emit({
                topic: 'discord:messageDelete',
                payload: {
                  messageId,
                  channelId,
                  timestamp: new Date().toISOString()
                },
                timestamp: Date.now()
              });
            }
          } else {
            console.log(`[Discord] No deleted messages detected`);
          }
        } else {
          console.log(`[Discord] No VEIL state available for deletion detection`);
        }
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
      
      // Emit message event with stream info - a Receptor will handle creating facets
      this.element.emit({
        topic: 'discord:message',
        payload: {
          ...msg,
          streamId,
          streamType: 'discord'
        },
        timestamp: Date.now()
      });
      
      // Update last read
      this.lastRead[msg.channelId] = msg.messageId;
      
      // Mark as processed to avoid duplicates
      this.processedMessages.add(msg.messageId);
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
      
      // Emit update event - a Receptor will handle creating facets
      this.element.emit({
        topic: 'discord:messageUpdate',
        payload: {
          ...msg,
          streamId,
          streamType: 'discord',
          facetId,
          oldContent,
          content
        },
        timestamp: Date.now()
      });
    }
    
    private handleMessageDelete(msg: any): void {
      const { channelId, messageId, author, timestamp } = msg;
      
      console.log(`[Discord] Message deleted - ID: ${messageId}, Author: ${author || 'unknown'}`);
      
      const facetId = `discord-msg-${messageId}`;
      const streamId = this.buildStreamId(msg.channelName, msg.guildName || this.guildName);
      
      // Emit delete event - a Receptor will handle creating facets
      this.element.emit({
        topic: 'discord:messageDelete',
        payload: {
          ...msg,
          streamId,
          streamType: 'discord',
          facetId,
          messageId,
          author
        },
        timestamp: Date.now()
      });
    }
    
    private setConnectionState(state: typeof this.connectionState, error?: string): void {
      this.connectionState = state;
      if (error) {
        this.lastError = error;
      }
      
      // In RETM architecture, just emit an event - a Receptor can create facets if needed
      this.element.emit({
        topic: 'discord:connection-state',
        payload: {
          state,
          error,
          serverUrl: this.serverUrl,
          attempts: this.connectionAttempts
        },
        timestamp: Date.now()
      });
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
      
      // Emit event - Receptor can create facets if needed
      this.element.emit({
        topic: 'discord:action-join',
        payload: { channelId },
        timestamp: Date.now()
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
      
      // Emit event - Receptor can create facets if needed
      this.element.emit({
        topic: 'discord:action-leave',
        payload: { channelId },
        timestamp: Date.now()
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
