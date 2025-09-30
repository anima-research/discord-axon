/**
 * Discord Application for Connectome
 */

import { ConnectomeApplication } from 'connectome-ts/src/host/types';
import { Space } from 'connectome-ts/src/spaces/space';
import { VEILStateManager } from 'connectome-ts/src/veil/veil-state';
import { ComponentRegistry } from 'connectome-ts/src/persistence/component-registry';
import { BasicAgent } from 'connectome-ts/src/agent/basic-agent';
import { AgentComponent } from 'connectome-ts/src/agent/agent-component';
import { persistable, persistent } from 'connectome-ts/src/persistence/decorators';
import { AxonLoaderComponent } from 'connectome-ts/src/components/axon-loader';
import { Element } from 'connectome-ts/src/spaces/element';
import { Component } from 'connectome-ts/src/spaces/component';
import { SpaceEvent } from 'connectome-ts/src/spaces/types';
import { BaseReceptor, BaseEffector } from 'connectome-ts/src/components/base-martem';
import { AgentEffector } from 'connectome-ts/src/agent/agent-effector';
import { ContextTransform } from 'connectome-ts/src/hud/context-transform';
import type { Facet, ReadonlyVEILState, FacetDelta, EffectorResult, AgentInterface } from 'connectome-ts/src';

export interface DiscordAppConfig {
  agentName: string;
  systemPrompt: string;
  llmProviderId: string;
  discord: {
    host: string;
    guild: string;
    modulePort?: number;
    autoJoinChannels?: string[];
  };
}

/**
 * Receptor: Converts discord:connected events to facets
 */
class DiscordConnectedReceptor extends BaseReceptor {
  topics = ['discord:connected'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): Facet[] {
    console.log('[DiscordConnectedReceptor] Processing discord:connected event');
    return [{
      id: `discord-connected-${Date.now()}`,
      type: 'event',
      content: 'Discord connected',
      eventType: 'discord-connected',
      attributes: event.payload as Record<string, any>
    }];
  }
}

/**
 * Receptor: Converts discord:message events into message facets and agent activations
 */
class DiscordMessageReceptor extends BaseReceptor {
  topics = ['discord:message'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): Facet[] {
    const payload = event.payload as any;
    const { channelId, channelName, author, content, messageId, streamId, streamType, isHistory } = payload;
    
    console.log(`[DiscordMessageReceptor] Processing message from ${author}: "${content}"${isHistory ? ' (history)' : ''}`);
    
    const facets: Facet[] = [];
    
    // Create message facet
    facets.push({
      id: `discord-msg-${messageId}`,
      type: 'event',
      content: `${author}: ${content}`,
      eventType: 'discord-message',
      attributes: {
        channelId,
        channelName,
        author,
        messageId,
        streamId,
        streamType,
        isHistory
      }
    });
    
    // Only activate agent for live messages, not history
    if (!isHistory) {
      console.log(`[DiscordMessageReceptor] Creating agent activation`);
      facets.push({
        id: `activation-${messageId}`,
        type: 'agent-activation',
        content: `Discord message from ${author}`,
        state: {
          source: 'discord-message',
          reason: 'discord_message',
          priority: 'normal',
          channelId,
          messageId,
          author,
          streamRef: {
            streamId,
            streamType,
            metadata: {
              channelId,
              channelName
            }
          }
        },
        ephemeral: true
      });
    }
    
    return facets;
  }
}

/**
 * Receptor: Handles message edits
 */
class DiscordMessageUpdateReceptor extends BaseReceptor {
  topics = ['discord:messageUpdate'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): Facet[] {
    const payload = event.payload as any;
    const { messageId, content, oldContent, author, channelName } = payload;
    
    console.log(`[DiscordMessageUpdateReceptor] Message ${messageId} edited by ${author}`);
    
    const facets: Facet[] = [];
    const facetId = `discord-msg-${messageId}`;
    
    // Check if the message facet exists
    if (state.facets.has(facetId)) {
      // Create an event facet for the edit
      facets.push({
        id: `discord-edit-${messageId}-${Date.now()}`,
        type: 'event',
        content: `${author} edited their message in #${channelName}`,
        eventType: 'discord-message-edited',
        attributes: {
          messageId,
          oldContent,
          newContent: content,
          author
        }
      });
    }
    
    return facets;
  }
}

/**
 * Receptor: Handles message deletions
 */
class DiscordMessageDeleteReceptor extends BaseReceptor {
  topics = ['discord:messageDelete'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): Facet[] {
    const payload = event.payload as any;
    const { messageId, author, channelName } = payload;
    
    console.log(`[DiscordMessageDeleteReceptor] Message ${messageId} deleted`);
    
    const facets: Facet[] = [];
    const facetId = `discord-msg-${messageId}`;
    
    // Check if the message facet exists
    if (state.facets.has(facetId)) {
      // Create an event facet for the deletion
      facets.push({
        id: `discord-delete-${messageId}-${Date.now()}`,
        type: 'event',
        content: `${author || 'Someone'} deleted their message in #${channelName || 'a channel'}`,
        eventType: 'discord-message-deleted',
        attributes: {
          messageId,
          author,
          deletedFacetId: facetId
        }
      });
    }
    
    return facets;
  }
}

/**
 * Effector: Auto-joins Discord channels when connected
 */
class DiscordAutoJoinEffector extends BaseEffector {
  facetFilters = [{ type: 'event' }];
  
  constructor(private channels: string[], private discordElement: Element) {
    super();
  }
  
  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    const events: SpaceEvent[] = [];
    
    // Check if we have a discord:connected facet
    const hasConnected = changes.some(
      c => c.type === 'added' && c.facet.type === 'event' && 
      (c.facet as any).eventType === 'discord-connected'
    );
    
    if (!hasConnected) {
      return { events };
    }
    
    console.log('🤖 Discord connected! Auto-joining channels:', this.channels);
    
    // Call join on the Discord afferent
    for (const channelId of this.channels) {
      console.log(`📢 Calling join for channel: ${channelId}`);
      
      // Find the Discord afferent (or component) and call join
      const components = this.discordElement.components as any[];
      for (const comp of components) {
        if (comp.join && typeof comp.join === 'function') {
          try {
            await comp.join({ channelId });
          } catch (error) {
            console.error(`Failed to join channel ${channelId}:`, error);
          }
          break;
        } else if (comp.actions && comp.actions.has('join')) {
          try {
            const handler = comp.actions.get('join');
            await handler({ channelId });
          } catch (error) {
            console.error(`Failed to join channel ${channelId}:`, error);
          }
          break;
        }
      }
    }
    
    return { events };
  }
}

/**
 * Effector: Sends agent speech to Discord
 */
class DiscordSpeechEffector extends BaseEffector {
  facetFilters = [{ type: 'speech' }];
  
  constructor(private discordElement: Element) {
    super();
  }
  
  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    const events: SpaceEvent[] = [];
    
    for (const change of changes) {
      if (change.type !== 'added' || change.facet.type !== 'speech') continue;
      
      const speech = change.facet as any;
      const streamId = speech.streamId;
      const content = speech.content;
      
      // Check if this is for Discord
      if (!streamId || !streamId.startsWith('discord:')) continue;
      
      console.log(`[DiscordSpeechEffector] Processing speech for stream: ${streamId}`);
      
      // Find the most recent discord message facet to get the channelId
      const discordMessages = Array.from(state.facets.values()).filter(
        f => f.type === 'event' && (f as any).eventType === 'discord-message'
      );
      
      if (discordMessages.length === 0) {
        console.warn('[DiscordSpeechEffector] No discord-message facets found');
        continue;
      }
      
      // Use the most recent message
      const latestMessage = discordMessages[discordMessages.length - 1] as any;
      const channelId = latestMessage.attributes?.channelId;
      
      if (!channelId) {
        console.warn('[DiscordSpeechEffector] No channelId in message facet');
        continue;
      }
      
      console.log(`[DiscordSpeechEffector] Sending to channel ${channelId}: "${content}"`);
      
      // Call send on the Discord afferent (or component)
      const components = this.discordElement.components as any[];
      for (const comp of components) {
        if (comp.send && typeof comp.send === 'function') {
          try {
            await comp.send({ channelId, message: content });
            console.log(`[DiscordSpeechEffector] Successfully sent message`);
          } catch (error) {
            console.error(`Failed to send to Discord:`, error);
          }
          break;
        } else if (comp.actions && comp.actions.has('send')) {
          try {
            const handler = comp.actions.get('send');
            await handler({ channelId, message: content });
            console.log(`[DiscordSpeechEffector] Successfully sent message`);
          } catch (error) {
            console.error(`Failed to send to Discord:`, error);
          }
          break;
        }
      }
    }
    
    return { events };
  }
}

/**
 * Test component that auto-joins Discord channels when connected
 * DEPRECATED: Use DiscordAutoJoinReceptor instead for RETM architecture
 */
@persistable(1)
class DiscordAutoJoinComponent extends Component {
  @persistent() private channels: string[] = [];
  @persistent() private hasJoined: boolean = false;
  
  constructor(channels: string[] = []) {  // No default channel - must be configured
    super();
    this.channels = channels;
  }
  
  onMount(): void {
    // Listen for Discord connected event at the space level
    const space = this.element.space;
    if (space) {
      space.subscribe('discord:connected');
      console.log('🔔 DiscordAutoJoinComponent subscribed to discord:connected at space level');
    }
    // Also subscribe at element level just in case
    this.element.subscribe('discord:connected');
  }
  
  async handleEvent(event: SpaceEvent): Promise<void> {
    console.log('🔔 DiscordAutoJoinComponent received event:', event.topic, 'from:', event.source);
    
    // Always try to join channels on discord:connected, not just the first time
    // This ensures we rejoin after restoration
    if (event.topic === 'discord:connected') {
      console.log('🤖 Discord connected! Auto-joining channels:', this.channels);
      console.log('Previous join state:', this.hasJoined ? 'had joined before' : 'first time joining');
      
      // Find the Discord element and emit join actions to it
      const space = this.element.space;
      console.log('Looking for Discord element. Space children:', space?.children.map(c => ({ id: c.id, name: c.name })));
      const discordElement = space?.children.find(child => child.name === 'discord');
      
      if (discordElement) {
        console.log('Found Discord element:', discordElement.name, 'with id:', discordElement.id);
        for (const channelId of this.channels) {
          console.log(`📢 Requesting to join channel: ${channelId}`);
          
          // Emit an action event with the correct format for Element handling
          this.element.space?.emit({
            topic: 'element:action',
            source: this.element.getRef(),
            payload: {
              path: [discordElement.id, 'join'],  // [elementId, action]
              parameters: { channelId }
            },
            timestamp: Date.now()
          });
        }
        this.hasJoined = true;
      } else {
        console.log('Discord element not found!');
      }
    }
  }
}

export class DiscordApplication implements ConnectomeApplication {
  constructor(private config: DiscordAppConfig) {}
  
  async createSpace(hostRegistry?: Map<string, any>): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry);
    
    // The Host will inject the actual llmProvider based on the config
    // No need to register the ID here
    
    return { space, veilState };
  }
  
  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🎮 Initializing Discord application (fresh start)...');
    
    // During initialization, we create NEW elements
    // Check if Discord element already exists (shouldn't happen in fresh start)
    let discordElem = space.children.find((child) => child.name === 'discord');
    
    if (discordElem) {
      console.log('✅ Found existing Discord element from persistence');
      // Check if it needs AxonLoader reconnection
      const axonLoader = discordElem.getComponents(AxonLoaderComponent)[0];
      
      if (axonLoader) {
        // Always try to reconnect in case the AXON server was restarted
        console.log('🔄 Ensuring Discord element is connected to AXON...');
        // Build the AXON URL - use new afferent module
        const modulePort = this.config.discord.modulePort || 8080;
        const axonUrl = `axon://localhost:${modulePort}/modules/discord-afferent/manifest?` + 
          `host=${encodeURIComponent(this.config.discord.host)}&` +
          `path=${encodeURIComponent('/ws')}&` +
          `guild=${encodeURIComponent(this.config.discord.guild)}&` +
          `agent=${encodeURIComponent(this.config.agentName)}`;
        
        try {
          await axonLoader.connect(axonUrl);
        } catch (e) {
          console.log('⚠️ Failed to reconnect, component may already be connected');
        }
      }
    } else {
      console.log('🆕 Creating new Discord element');
      // Create Discord element with AxonLoaderComponent for the Afferent
      discordElem = new Element('discord', 'discord');
      const axonLoader = new AxonLoaderComponent();
      
      // Build the AXON URL - use discord-afferent module
      const modulePort = this.config.discord.modulePort || 8080;
      const axonUrl = `axon://localhost:${modulePort}/modules/discord-afferent/manifest?` + 
        `host=${encodeURIComponent(this.config.discord.host)}&` +
        `path=${encodeURIComponent('/ws')}&` +
        `guild=${encodeURIComponent(this.config.discord.guild)}&` +
        `agent=${encodeURIComponent(this.config.agentName)}`;
      
      // Add Discord element to space first
      space.addChild(discordElem);
      
      // Add the component and wait for it to mount
      await discordElem.addComponentAsync(axonLoader);
      
      // Connect to the AXON afferent server
      await axonLoader.connect(axonUrl);
    }
    
    // Check if agent element already exists (from persistence)
    let agentElem = space.children.find((child) => child.name === 'discord-agent');
    
    if (agentElem) {
      console.log('✅ Found existing agent element from persistence');
      // Update agent config if needed
      const agentComponent = agentElem.getComponents(AgentComponent)[0];
      
      if (agentComponent) {
        // Update config for current session
        const agentConfig = {
          name: this.config.agentName,
          systemPrompt: this.config.systemPrompt,
          autoActionRegistration: true
        };
        (agentComponent as any).agentConfig = agentConfig;
      }
    } else {
      console.log('🆕 Creating new agent element');
      // Create agent element
      agentElem = new Element('discord-agent');
    
    // Create agent component without agent (will be created after references are resolved)
    const agentComponent = new AgentComponent();
    
    // Store config for agent creation
    const agentConfig = {
      name: this.config.agentName,
      systemPrompt: this.config.systemPrompt,
      autoActionRegistration: true
    };
    
    // Save config for restoration
    (agentComponent as any).agentConfig = agentConfig;
    
    agentElem.addComponent(agentComponent);
    }
    
    // Add RETM components for Discord integration
    space.addReceptor(new DiscordConnectedReceptor());
    space.addReceptor(new DiscordMessageReceptor());
    space.addReceptor(new DiscordMessageUpdateReceptor());
    space.addReceptor(new DiscordMessageDeleteReceptor());
    space.addEffector(new DiscordSpeechEffector(discordElem));
    
    if (this.config.discord.autoJoinChannels && this.config.discord.autoJoinChannels.length > 0 && discordElem) {
      console.log('➕ Adding auto-join effector for channels:', this.config.discord.autoJoinChannels);
      const autoJoinEffector = new DiscordAutoJoinEffector(
        this.config.discord.autoJoinChannels,
        discordElem
      );
      space.addEffector(autoJoinEffector);
    }
    
    // Add agent element to space only if it's a new element
    if (!space.children.includes(agentElem)) {
    space.addChild(agentElem);
    }
    
    // Subscribe to agent response events
    space.subscribe('agent:frame-ready');
    
    // Create Discord control panel (only during initialization)
    console.log('📋 Creating Discord control panel...');
    const controlElement = new Element('discord-control');
    const controlLoader = new AxonLoaderComponent();
    await controlElement.addComponentAsync(controlLoader);
    space.addChild(controlElement);
    
    // Connect to the control panel module
    await controlLoader.connect('axon://localhost:8080/modules/discord-control-panel/manifest');
    
    console.log('✅ Discord application initialized');
  }
  
  getComponentRegistry(): typeof ComponentRegistry {
    const registry = ComponentRegistry;
    
    // Register all components that can be restored
    registry.register('AxonLoaderComponent', AxonLoaderComponent);
    registry.register('AgentComponent', AgentComponent);
    registry.register('DiscordAutoJoinComponent', DiscordAutoJoinComponent);
    
    return registry;
  }
  
  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Discord application started!');
    
    // Register RETM components for agent processing
    // Find the agent element and component
    const agentElem = space.children.find(child => child.name === 'discord-agent');
    if (agentElem) {
      const agentComponent = agentElem.getComponents(AgentComponent)[0];
      if (agentComponent && (agentComponent as any).agent) {
        const agent = (agentComponent as any).agent as AgentInterface;
        
        console.log('➕ Registering AgentEffector and ContextTransform');
        space.addEffector(new AgentEffector(agentElem, agent));
        space.addTransform(new ContextTransform(veilState));
      }
    }
    
    // No initial activation - wait for Discord messages to trigger the agent
  }
  
  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored from snapshot');
    // No activation needed - Discord messages will trigger the agent
  }
}
