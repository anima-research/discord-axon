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
 * Test component that auto-joins Discord channels when connected
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
        // Build the AXON URL with connection parameters
        const modulePort = this.config.discord.modulePort || 8080;
        const axonUrl = `axon://localhost:${modulePort}/modules/discord-chat/manifest?` + 
          `host=${encodeURIComponent(this.config.discord.host)}&` +
          `path=${encodeURIComponent('/ws')}&` +
          `guild=${encodeURIComponent(this.config.discord.guild)}&` +
          `agent=${encodeURIComponent(this.config.agentName)}&` +
          // Chat trigger configuration
          `mentions=true&` +
          `directMessages=true&` +
          `keywords=${encodeURIComponent('hi,hello,help,?,connectome')}&` +
          `cooldown=0`;
        
        try {
          await axonLoader.connect(axonUrl);
        } catch (e) {
          console.log('⚠️ Failed to reconnect, component may already be connected');
        }
      }
    } else {
      console.log('🆕 Creating new Discord element');
      // Create Discord element with AxonLoaderComponent
      discordElem = new Element('discord', 'discord');
      const axonLoader = new AxonLoaderComponent();
      
      // Build the AXON URL with connection parameters
      // Default to module server port (8080)
      const modulePort = this.config.discord.modulePort || 8080;
      const axonUrl = `axon://localhost:${modulePort}/modules/discord-chat/manifest?` + 
        `host=${encodeURIComponent(this.config.discord.host)}&` +
        `path=${encodeURIComponent('/ws')}&` +
        `guild=${encodeURIComponent(this.config.discord.guild)}&` +
        `agent=${encodeURIComponent(this.config.agentName)}&` +
        // Chat trigger configuration
        `mentions=true&` +
        `directMessages=true&` +
        `keywords=${encodeURIComponent('hi,hello,help,?,connectome')}&` +
        `cooldown=0`;
      
      // Add Discord element to space first
      space.addChild(discordElem);
      
      // Add the component and wait for it to mount
      await discordElem.addComponentAsync(axonLoader);
      
      // Connect to the AXON component server
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
    
    // Add auto-join component for testing (if not already present)
    if (this.config.discord.autoJoinChannels && this.config.discord.autoJoinChannels.length > 0) {
      const hasAutoJoin = agentElem.getComponents(DiscordAutoJoinComponent).length > 0;
      
      if (!hasAutoJoin) {
        console.log('➕ Adding auto-join component');
        const autoJoinComponent = new DiscordAutoJoinComponent(this.config.discord.autoJoinChannels);
        agentElem.addComponent(autoJoinComponent);
      }
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
    // No initial activation - wait for Discord messages to trigger the agent
  }
  
  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored from snapshot');
    // No activation needed - Discord messages will trigger the agent
  }
}
