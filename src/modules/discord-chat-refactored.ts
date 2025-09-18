/**
 * Discord Chat Component - Refactored for interface-based architecture
 * 
 * Extends DiscordAxonComponent to provide chat interface functionality.
 * Handles message triggers and agent activation based on configurable rules.
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
  persistable: (version: number) => (target: any) => void;
  external: (resourceId: string) => (target: any, propertyKey: string) => void;
  WebSocket?: any;
}

interface TriggerConfig {
  mentions: boolean;          // Respond to @mentions
  directMessages: boolean;    // Respond to DMs
  keywords: string[];        // Keywords to trigger on
  channels: string[];        // Specific channels to monitor (empty = all)
  cooldown: number;          // Minimum seconds between responses
}

interface CooldownEntry {
  channelId: string;
  userId: string;
  timestamp: number;
}

// Module factory function that extends the base Discord component
export function createModule(env: IAxonEnvironment) {
  const {
    persistent,
    persistable,
    external
  } = env;
  
  // Get the base DiscordAxonComponent from the environment
  // It should have been loaded as a dependency and injected into env
  const DiscordAxonComponent = (env as any).DiscordAxonComponent;
  
  if (!DiscordAxonComponent) {
    throw new Error('DiscordAxonComponent dependency not found in environment');
  }
  
  @persistable(1)
  class DiscordChatComponent extends DiscordAxonComponent {
    // Re-declare external token for decorator to work (decorators don't inherit)
    @external('secret:discord.token')
    protected botToken?: string;
    
    // Chat configuration
    @persistent
    private triggerConfig: TriggerConfig = {
      mentions: true,
      directMessages: true,
      keywords: [],
      channels: [],
      cooldown: 0
    };
    
    // Cooldown tracking
    @persistent
    private cooldowns: CooldownEntry[] = [];
    
    // Track last active channel for responses
    @persistent
    private lastActiveChannel?: string;
    
    // Track processed messages to avoid duplicates
    private processedMessages: Set<string> = new Set();
    
    // Static metadata for persistence
    static persistentProperties: IPersistentMetadata[] = [
      { propertyKey: 'triggerConfig' },
      { propertyKey: 'cooldowns' },
      { propertyKey: 'lastActiveChannel' },
      // Include parent properties if needed
      ...(DiscordAxonComponent as any).persistentProperties || []
    ];
    
    static externalResources: IExternalMetadata[] = [
      { propertyKey: 'botToken', resourceId: 'secret:discord.token' },
      // Include parent external resources if needed
      ...(DiscordAxonComponent as any).externalResources || []
    ];
    
    // Declare available actions (extends parent actions)
    static actions = {
      ...((DiscordAxonComponent as any).actions || {}),
      'setTriggerConfig': {
        description: 'Configure chat triggers',
        parameters: {
          config: { type: 'object', required: true }
        }
      }
    };
    
    constructor() {
      super();
      
      // Register additional action handlers
      this.registerAction('setTriggerConfig', this.setTriggerConfig.bind(this));
    }
    
    // Override to handle chat-specific parameters
    setConnectionParams(params: any): void {
      // Call parent implementation
      super.setConnectionParams(params);
      
      // Handle chat-specific parameters
      if (params.keywords) {
        const keywords = typeof params.keywords === 'string' 
          ? params.keywords.split(',').map(k => k.trim()).filter(k => k)
          : params.keywords;
        this.triggerConfig.keywords = keywords;
        console.log(`[DiscordChat] Parsed keywords:`, keywords);
      }
      
      if (params.mentions !== undefined) {
        this.triggerConfig.mentions = params.mentions === 'true' || params.mentions === true;
      }
      
      if (params.directMessages !== undefined) {
        this.triggerConfig.directMessages = params.directMessages === 'true' || params.directMessages === true;
      }
      
      if (params.cooldown !== undefined) {
        this.triggerConfig.cooldown = parseInt(params.cooldown) || 0;
      }
    }
    
    async onMount(): Promise<void> {
      await super.onMount();
      
      console.log('[DiscordChat] Component mounted - VERSION 2 with debugging');
      
      // Subscribe to discord:connected to get bot user ID
      this.element.subscribe('discord:connected');
      
      // Subscribe to Discord message events
      this.element.subscribe('discord:message');
      
      // Subscribe to agent frame ready events
      this.element.subscribe('agent:frame-ready');
      
      // Subscribe to history events to mark messages as processed
      this.element.subscribe('discord:history-received');
    }
    
    async handleEvent(event: ISpaceEvent): Promise<void> {
      await super.handleEvent(event);
      
      console.log(`[DiscordChat] Received event: ${event.topic}`);
      
      // Handle Discord messages with trigger logic
      if (event.topic === 'discord:message') {
        const msg = event.payload as any;
        console.log(`[DiscordChat] Processing discord:message - messageId: ${msg.messageId}, author: ${msg.author}, content: "${msg.content}"`);
        
        // Skip if already processed
        if (this.processedMessages.has(msg.messageId)) {
          console.log(`[DiscordChat] Message ${msg.messageId} already processed, skipping (this might be a duplicate event)`);
          console.log(`[DiscordChat] processedMessages size: ${this.processedMessages.size}`);
          console.log(`[DiscordChat] First 5 processed IDs:`, Array.from(this.processedMessages).slice(0, 5));
          // Don't return - let's see if it would trigger
          // return;
        }
        
        // Mark as processed
        this.processedMessages.add(msg.messageId);
        
        // Update last active channel
        this.lastActiveChannel = msg.channelId;
        
        console.log(`[DiscordChat] Current botUserId: ${this.botUserId}`);
        
        // Check if we should respond
        if (this.shouldRespond(msg)) {
          console.log(`[DiscordChat] Triggering agent activation for channel ${msg.channelId}`);
          
          // Add agent activation operation
          this.addOperation({
            type: 'agentActivation',
            source: 'discord-chat',
            reason: this.getTriggerReason(msg) || 'discord_message',
            priority: 'normal',
            metadata: {
              channelId: msg.channelId,
              messageId: msg.messageId,
              author: msg.author
            }
          });
          
          // Update cooldown
          this.updateCooldown(msg.channelId, msg.author);
        }
      }
      
      // Handle discord:connected event to get bot user ID
      if (event.topic === 'discord:connected') {
        const { botUserId } = event.payload as any;
        if (botUserId) {
          this.botUserId = botUserId;
          console.log(`[DiscordChat] Received bot user ID: ${this.botUserId}`);
        }
      }
      
      // Mark history messages as processed
      if (event.topic === 'discord:history-received') {
        const { messages } = event.payload as any;
        console.log(`[DiscordChat] Marking ${messages.length} historical messages as processed`);
        
        for (const msg of messages) {
          this.processedMessages.add(msg.messageId);
        }
      }
      
      // Handle agent frame ready events
      if (event.topic === 'agent:frame-ready') {
        const { frame } = event.payload as any;
        console.log(`[DiscordChat] Agent frame ready with ${frame.operations?.length || 0} operations`);
        
        // Look for speak operations
        if (frame.operations) {
          for (const op of frame.operations) {
            if (op.type === 'speak') {
              console.log(`[DiscordChat] Found speak operation: "${op.content}"`);
              
              // Send to the last active channel
              const targetChannel = this.getLastActiveChannel();
              
              if (targetChannel) {
                console.log(`[DiscordChat] Sending to Discord channel: ${targetChannel}`);
                await (this as any).send({ 
                  channelId: targetChannel, 
                  message: op.content 
                });
              } else {
                console.warn('[DiscordChat] No active channel to send agent response to.');
              }
            }
          }
        }
      }
    }
    
    /**
     * Set trigger configuration
     */
    async setTriggerConfig(params: { config: Partial<TriggerConfig> }): Promise<void> {
      this.triggerConfig = {
        ...this.triggerConfig,
        ...params.config
      };
      
      console.log('[DiscordChat] Updated trigger config:', this.triggerConfig);
      
      // Add config update facet
      this.addFacet({
        id: `trigger-config-update-${Date.now()}`,
        type: 'state',
        displayName: 'trigger-config',
        content: 'Chat trigger configuration updated',
        attributes: this.triggerConfig
      });
    }
    
    /**
     * Check if we should respond to a message
     */
    private shouldRespond(msg: any): boolean {
      console.log(`[DiscordChat] Checking triggers for message from ${msg.author}`);
      
      // Skip bot messages (including our own)
      if (msg.author === this.botUserId) {
        console.log('[DiscordChat] Skipping our own message');
        return false;
      }
      
      // Check cooldown
      if (this.isOnCooldown(msg.channelId, msg.author)) {
        console.log('[DiscordChat] User is on cooldown');
        return false;
      }
      
      // Check channel filter
      if (this.triggerConfig.channels.length > 0 && 
          !this.triggerConfig.channels.includes(msg.channelId)) {
        console.log('[DiscordChat] Channel not in allowed list');
        return false;
      }
      
      // Check triggers
      const reason = this.getTriggerReason(msg);
      const shouldRespond = reason !== null;
      
      console.log(`[DiscordChat] Message from ${msg.author}: "${msg.content}" - shouldRespond: ${shouldRespond}`);
      
      return shouldRespond;
    }
    
    /**
     * Get the reason this message triggered a response
     */
    private getTriggerReason(msg: any): string | null {
      const content = msg.content.toLowerCase();
      
      // Check mentions
      if (this.triggerConfig.mentions && this.botUserId) {
        if (content.includes(`<@${this.botUserId}>`) || 
            content.includes(`<@!${this.botUserId}>`)) {
          return 'mention';
        }
      }
      
      // Check keywords
      console.log(`[DiscordChat] Checking keywords. Config keywords:`, this.triggerConfig.keywords);
      console.log(`[DiscordChat] Message content (lowercase): "${content}"`);
      if (this.triggerConfig.keywords.length > 0) {
        for (const keyword of this.triggerConfig.keywords) {
          console.log(`[DiscordChat] Checking if "${content}" includes "${keyword.toLowerCase()}"`);
          if (content.includes(keyword.toLowerCase())) {
            return `keyword:${keyword}`;
          }
        }
      }
      
      // For DMs, we'd need to check if it's a DM channel
      // This would require more context about the channel
      
      return null;
    }
    
    /**
     * Check if a user is on cooldown
     */
    private isOnCooldown(channelId: string, userId: string): boolean {
      if (this.triggerConfig.cooldown <= 0) return false;
      
      const now = Date.now();
      const cooldownMs = this.triggerConfig.cooldown * 1000;
      
      // Clean old cooldowns
      this.cooldowns = this.cooldowns.filter(cd => 
        now - cd.timestamp < cooldownMs
      );
      
      // Check if user is on cooldown
      return this.cooldowns.some(cd => 
        cd.channelId === channelId && 
        cd.userId === userId
      );
    }
    
    /**
     * Update cooldown for a user
     */
    private updateCooldown(channelId: string, userId: string): void {
      if (this.triggerConfig.cooldown <= 0) return;
      
      this.cooldowns.push({
        channelId,
        userId,
        timestamp: Date.now()
      });
    }
    
    /**
     * Get the last active channel
     */
    private getLastActiveChannel(): string | undefined {
      return this.lastActiveChannel;
    }
  }
  
  return DiscordChatComponent;
}
