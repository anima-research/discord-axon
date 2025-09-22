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
  messageId: string;
  author: string;
  content: string;
  timestamp: string;
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
    protected agentName: string = 'Connectome Agent';
    
    @persistent
    protected botUserId: string = '';
    
    // Bot token is external (not persisted for security)
    @external('secret:discord.token')
    protected botToken?: string;
    
    // Persistent state
    @persistent
    private connectionState: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    
    @persistent
    private lastError?: string;
    
    @persistent
    private connectionAttempts: number = 0;
    
    @persistent
    protected joinedChannels: string[] = [];
    
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
    
    // Static metadata for persistence
    static persistentProperties: IPersistentMetadata[] = [
      { propertyKey: 'serverUrl' },
      { propertyKey: 'connectionParams' },
      { propertyKey: 'guildId' },
      { propertyKey: 'agentName' },
      { propertyKey: 'botUserId' },
      { propertyKey: 'connectionState' },
      { propertyKey: 'lastError' },
      { propertyKey: 'connectionAttempts' },
      { propertyKey: 'joinedChannels' },
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
    
    async onMount(): Promise<void> {
      console.log('[Discord] Component mounted');
      
      // Subscribe to relevant events
      this.element.subscribe('frame:start');
      this.element.subscribe('frame:end'); 
      this.element.subscribe('element:action');
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
          
        case 'error':
          console.error('[Discord] Server error:', msg.error);
          this.setConnectionState('error', msg.error);
          break;
          
        default:
          console.warn('[Discord] Unknown message type:', msg.type);
      }
    }
    
    private handleHistoryMessage(msg: any): void {
      const channelId = msg.channelId;
      const channelName = msg.channelName;
      const messages = msg.messages || [];
      
      console.log(`[Discord] Received history for channel ${channelName} (${channelId}): ${messages.length} messages`);
      
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
      
      // Update last read for the channel
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        this.lastRead[channelId] = lastMessage.messageId;
      }
    }
    
    private handleLiveMessage(msg: DiscordMessage): void {
      if (this.processedMessages.has(msg.messageId)) {
        console.log(`[Discord] Skipping duplicate message ${msg.messageId}`);
        return;
      }
      
      // Don't add to processedMessages here - let the chat component handle its own tracking
      // this.processedMessages.add(msg.messageId);
      
      // Emit message event
      this.element.emit({
        topic: 'discord:message',
        payload: msg,
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
          messageId: msg.messageId,
          author: msg.author,
          content: msg.content,
          timestamp: msg.timestamp,
          guildId: this.guildId
        }
      });
      
      // Update last read
      this.lastRead[msg.channelId] = msg.messageId;
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
      
      // Add send event
      this.addFacet({
        id: `discord-send-${Date.now()}`,
        type: 'action',
        displayName: 'discord-send',
        content: JSON.stringify({ channelId, message }),
        attributes: {
          agentGenerated: false,
          toolName: 'discord-send',
          parameters: {
            channelId,
            message
          }
        }
      });
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
