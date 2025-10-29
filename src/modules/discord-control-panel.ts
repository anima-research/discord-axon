/**
 * Discord Control Panel Component
 * 
 * Provides UI and actions for managing Discord server/channel connections
 */

// Import shared AXON types from the centralized package
import type { 
  IInteractiveComponent, 
  ISpaceEvent, 
  IPersistentMetadata, 
  IExternalMetadata, 
  IAxonEnvironment 
} from '@connectome/axon-interfaces';

// Guild and channel info types
interface GuildInfo {
  id: string;
  name: string;
  icon?: string;
  memberCount?: number;
}

interface ChannelInfo {
  id: string;
  name: string;
  type: number; // 0 = text, 2 = voice, etc
  guildId: string;
  guildName: string;
  position: number;
  parentId?: string; // Category ID
  topic?: string;
}

interface CategoryInfo {
  id: string;
  name: string;
  channels: ChannelInfo[];
}

// Module factory function  
export function createModule(env: IAxonEnvironment): typeof env.InteractiveComponent {
  const {
    InteractiveComponent,
    persistent,
    external
  } = env;
  
  class DiscordControlPanelComponent extends InteractiveComponent {
    // Available guilds and channels
    @persistent
    private availableGuilds: GuildInfo[] = [];
    
    @persistent
    private availableChannels: Record<string, ChannelInfo[]> = {}; // guildId -> channels
    
    @persistent
    private joinedChannels: Set<string> = new Set();
    
    // UI state
    @persistent
    private selectedGuildId?: string;
    
    // Track whether we've emitted action facets
    @persistent
    private hasEmittedActions: boolean = false;
    
    @persistent
    private showCategories: boolean = true;

    private emitControlEvent(
      id: string,
      content: string,
      eventType: string,
      metadata: Record<string, any> = {}
    ): void {
      this.addEvent(
        content,
        eventType,
        id,
        {
          streamId: 'discord:control',
          streamType: 'discord',
          ...metadata
        }
      );
    }

    private emitControlError(
      id: string,
      message: string,
      metadata: Record<string, any> = {}
    ): void {
      this.emitControlEvent(id, message, 'discord-control:error', {
        severity: 'error',
        ...metadata
      });
    }

    // Static metadata for persistence
    static persistentProperties: IPersistentMetadata[] = [
      { propertyKey: 'availableGuilds' },
      { propertyKey: 'availableChannels' },
      { propertyKey: 'joinedChannels' },
      { propertyKey: 'selectedGuildId' },
      { propertyKey: 'hasEmittedActions' },
      { propertyKey: 'showCategories' }
    ];
    
    async onMount(): Promise<void> {
      console.log('[DiscordControlPanel] Component mounted');
      
      // Subscribe to frame events
      this.element.subscribe('frame:start');
      
      // Subscribe to Discord events
      this.element.subscribe('discord:connected');
      this.element.subscribe('discord:guilds-listed');
      this.element.subscribe('discord:channels-listed');
      this.element.subscribe('discord:channel-joined');
      this.element.subscribe('discord:channel-left');
      
      // Register actions
      this.registerAction('listServers', async () => {
        await this.listGuilds();
      });
      
      this.registerAction('listChannels', async (params) => {
        const serverName = params?.serverName || this.getSelectedServerName();
        if (!serverName) {
          this.emitControlError(
            'discord-error-no-server',
            'No server selected. Use listServers first.',
            { ttl: 5000 }
          );
          return;
        }

        const guild = this.findGuildByName(serverName);
        if (!guild) {
          this.emitControlError(
            'discord-error-unknown-server',
            `Unknown server: ${serverName}`,
            { ttl: 5000 }
          );
          return;
        }
        
        await this.listChannels(guild.id);
      });
      
      this.registerAction('joinChannel', async (params) => {
        if (!params?.channelName) {
          this.emitControlError(
            'discord-error-no-channel',
            'No channel name provided',
            { ttl: 5000 }
          );
          return;
        }

        const serverName = params.serverName || this.getSelectedServerName();
        if (!serverName) {
          this.emitControlError(
            'discord-error-no-server-join',
            'No server specified. Provide serverName or select a server first.',
            { ttl: 5000 }
          );
          return;
        }

        const channel = this.findChannelByName(params.channelName, serverName);
        if (!channel) {
          this.emitControlError(
            'discord-error-unknown-channel',
            `Channel #${params.channelName} not found in server ${serverName}`,
            { ttl: 5000 }
          );
          return;
        }
        
        await this.joinChannel(channel.id);
      });
      
      this.registerAction('leaveChannel', async (params) => {
        if (!params?.channelName) {
          this.emitControlError(
            'discord-error-no-channel-leave',
            'No channel name provided',
            { ttl: 5000 }
          );
          return;
        }
        
        // Find channel across all joined channels
        let targetChannel: ChannelInfo | undefined;
        for (const channelId of this.joinedChannels) {
          const channel = this.findChannel(channelId);
          if (channel && channel.name === params.channelName) {
            if (!params.serverName || channel.guildName === params.serverName) {
              targetChannel = channel;
              break;
            }
          }
        }
        
        if (!targetChannel) {
          this.emitControlError(
            'discord-error-not-in-channel',
            `Not in channel #${params.channelName}${params.serverName ? ` in ${params.serverName}` : ''}`,
            { ttl: 5000 }
          );
          return;
        }
        
        await this.leaveChannel(targetChannel.id);
      });
      
      this.registerAction('showJoinedChannels', async () => {
        await this.showJoinedChannels();
      });
      
      this.registerAction('refreshInstructions', async () => {
        // Force re-emission of action registrations and instructions
        this.hasEmittedActions = false;
        this.createControlPanelFacet();
        this.emitActionRegistrations();
        this.emitUsageInstructions();
        this.hasEmittedActions = true;
        
        this.emitControlEvent(
          'discord-instructions-refreshed',
          'Discord control panel instructions have been refreshed',
          'discord-control:info',
          { ttl: 3000 }
        );
      });
      
      this.registerAction('selectServer', async (params) => {
        if (!params?.serverName) {
          this.emitControlError(
            'discord-error-no-server-select',
            'No server name provided',
            { ttl: 5000 }
          );
          return;
        }

        const guild = this.findGuildByName(params.serverName);
        if (!guild) {
          this.emitControlError(
            'discord-error-unknown-server-select',
            `Unknown server: ${params.serverName}`,
            { ttl: 5000 }
          );
          return;
        }
        
        this.selectedGuildId = guild.id;
        await this.listChannels(guild.id);
      });
      
      // Don't emit VEIL operations in onMount - wait for first frame
    }
    
    async handleEvent(event: ISpaceEvent): Promise<void> {
      switch (event.topic) {
        case 'frame:start':
          // Ensure action registrations are available on first frame
          // Since hasEmittedActions is persistent, this only runs once per component lifetime
          // If you need to update instructions after code changes, reset hasEmittedActions to false
          if (!this.hasEmittedActions) {
            // Create initial UI facet
            this.createControlPanelFacet();
            
            // Emit action registration facets
            this.emitActionRegistrations();
            
            // Emit usage instructions
            this.emitUsageInstructions();
            
            this.hasEmittedActions = true;
          }
          break;
          
        case 'discord:connected':
          // Request guild list on connection
          setTimeout(() => this.listGuilds(), 1000);
          break;
          
        case 'discord:guilds-listed':
          this.handleGuildsList(event.payload as any);
          break;
          
        case 'discord:channels-listed':
          this.handleChannelsList(event.payload as any);
          break;
          
        case 'discord:channel-joined':
          this.handleChannelJoined(event.payload as any);
          break;
          
        case 'discord:channel-left':
          this.handleChannelLeft(event.payload as any);
          break;
      }
    }
    
    private async listGuilds(): Promise<void> {
      console.log('[DiscordControlPanel] Requesting guild list');
      
      // Request guild list from Discord component
      this.element.emit({
        topic: 'discord:request-guilds',
        payload: {},
        timestamp: Date.now()
      });
    }
    
    private async listChannels(guildId: string): Promise<void> {
      console.log(`[DiscordControlPanel] Requesting channels for guild ${guildId}`);
      
      // Request channel list from Discord component
      this.element.emit({
        topic: 'discord:request-channels',
        payload: { guildId },
        timestamp: Date.now()
      });
    }
    
    private async joinChannel(channelId: string): Promise<void> {
      console.log(`[DiscordControlPanel] Requesting to join channel ${channelId}`);
      
      // Find channel info
      const channel = this.findChannel(channelId);
      if (!channel) {
        this.emitControlError(
          'discord-error-unknown-channel',
          `Unknown channel ID: ${channelId}`,
          { ttl: 5000 }
        );
        return;
      }
      
      // Emit join request to Discord component
      this.element.emit({
        topic: 'discord:join-channel',
        payload: { 
          channelId,
          channelName: channel.name,
          guildId: channel.guildId,
          guildName: channel.guildName
        },
        timestamp: Date.now()
      });
    }
    
    private async leaveChannel(channelId: string): Promise<void> {
      console.log(`[DiscordControlPanel] Requesting to leave channel ${channelId}`);
      
      // Emit leave request to Discord component
      this.element.emit({
        topic: 'discord:leave-channel',
        payload: { channelId },
        timestamp: Date.now()
      });
    }
    
    private async showJoinedChannels(): Promise<void> {
      const joinedList = Array.from(this.joinedChannels).map(channelId => {
        const channel = this.findChannel(channelId);
        return channel ? `${channel.guildName}:#${channel.name}` : channelId;
      });
      
      this.addFacet({
        id: 'discord-joined-channels',
        type: 'state',
        content: joinedList.length > 0
          ? `Currently in: ${joinedList.join(', ')}`
          : 'Not in any channels',
        attributes: {
          entityType: 'component',
          entityId: this.element.id,
          channels: Array.from(this.joinedChannels),
          count: this.joinedChannels.size
        }
      });
    }
    
    private handleGuildsList(payload: { guilds: GuildInfo[] }): void {
      if (!payload || !payload.guilds) {
        console.warn('[DiscordControlPanel] Received invalid guilds payload:', payload);
        return;
      }
      this.availableGuilds = payload.guilds;
      console.log(`[DiscordControlPanel] Received ${payload.guilds.length} guilds`);
      
      // Update UI
      this.createControlPanelFacet();
      
      // Create guild list facet
      this.addFacet({
        id: 'discord-guilds-list',
        type: 'state',
        content: this.formatGuildsList(),
        attributes: {
          entityType: 'component',
          entityId: this.element.id,
          guilds: payload.guilds,
          count: payload.guilds.length
        }
      });
    }
    
    private handleChannelsList(payload: { guildId: string; channels: ChannelInfo[] }): void {
      if (!payload || !payload.channels || !payload.guildId) {
        console.warn('[DiscordControlPanel] Received invalid channels payload:', payload);
        return;
      }
      this.availableChannels[payload.guildId] = payload.channels;
      console.log(`[DiscordControlPanel] Received ${payload.channels.length} channels for guild ${payload.guildId}`);
      
      // Update UI
      this.createControlPanelFacet();
      
      // Create channel list facet
      const guild = this.availableGuilds.find(g => g.id === payload.guildId);
      this.addFacet({
        id: `discord-channels-${payload.guildId}`,
        type: 'state',
        content: this.formatChannelsList(payload.channels),
        attributes: {
          entityType: 'component',
          entityId: this.element.id,
          guildId: payload.guildId,
          guildName: guild?.name,
          channels: payload.channels,
          count: payload.channels.length
        }
      });
    }
    
    private handleChannelJoined(payload: any): void {
      // Handle successful channel join - payload is the channel object
      if (payload && payload.id) {
        this.joinedChannels.add(payload.id);
        console.log(`[DiscordControlPanel] Successfully joined channel ${payload.id}`);
        
        this.emitControlEvent(
          `discord-joined-${payload.id}`,
          `Joined ${payload.guildName}:#${payload.name}`,
          'discord-control:status',
          { ttl: 5000 }
        );
      } else {
        console.error(`[DiscordControlPanel] Invalid channel joined payload:`, payload);
        this.emitControlError(
          'discord-join-error-invalid',
          'Failed to join channel: Invalid payload received',
          { ttl: 5000 }
        );
      }
      
      // Update UI
      this.createControlPanelFacet();
    }
    
    private handleChannelLeft(payload: { channelId: string }): void {
      this.joinedChannels.delete(payload.channelId);
      console.log(`[DiscordControlPanel] Left channel ${payload.channelId}`);
      
      const channel = this.findChannel(payload.channelId);
      this.emitControlEvent(
        `discord-left-${payload.channelId}`,
        `Left ${channel ? `${channel.guildName}:#${channel.name}` : payload.channelId}`,
        'discord-control:status',
        { ttl: 5000 }
      );
      
      // Update UI
      this.createControlPanelFacet();
    }
    
    private createControlPanelFacet(): void {
      const selectedGuild = this.availableGuilds.find(g => g.id === this.selectedGuildId);
      const channels = this.selectedGuildId ? (this.availableChannels[this.selectedGuildId] || []) : [];
      
      this.updateState('discord-control-panel', {
        content: this.formatControlPanel(),
        attributes: {
          guilds: this.availableGuilds,
          selectedGuild: selectedGuild,
          channels: channels,
          joinedChannels: Array.from(this.joinedChannels)
        }
      });
    }
    
    private formatControlPanel(): string {
      const parts: string[] = ['Discord Control Panel\n'];
      
      // Guilds section
      if (this.availableGuilds.length > 0) {
        parts.push(`\nServers (${this.availableGuilds.length}):`);
        this.availableGuilds.forEach(guild => {
          const selected = guild.id === this.selectedGuildId ? ' [SELECTED]' : '';
          parts.push(`  • ${guild.name}${selected}`);
          parts.push(`    ID: ${guild.id}`);
          if (guild.memberCount) {
            parts.push(`    Members: ${guild.memberCount}`);
          }
        });
      } else {
        parts.push('\nNo servers available. Use "listServers" action.');
      }
      
      // Channels section
      if (this.selectedGuildId && this.availableChannels[this.selectedGuildId]) {
        const channels = this.availableChannels[this.selectedGuildId];
        parts.push(`\nChannels in selected server (${channels.length}):`);
        
        if (this.showCategories) {
          const categorized = this.categorizeChannels(channels);
          categorized.forEach(category => {
            parts.push(`  📁 ${category.name}`);
            category.channels.forEach(channel => {
              const joined = this.joinedChannels.has(channel.id) ? ' ✓' : '';
              parts.push(`    #${channel.name}${joined}`);
            });
          });
        } else {
          channels.forEach(channel => {
            const joined = this.joinedChannels.has(channel.id) ? ' ✓' : '';
            parts.push(`  #${channel.name}${joined}`);
          });
        }
      }
      
      // Joined channels
      if (this.joinedChannels.size > 0) {
        parts.push(`\nCurrently joined (${this.joinedChannels.size}):`);
        this.joinedChannels.forEach(channelId => {
          const channel = this.findChannel(channelId);
          if (channel) {
            parts.push(`  • ${channel.guildName}:#${channel.name}`);
          }
        });
      }
      
      // Actions
      parts.push('\nAvailable actions:');
      parts.push('  • @discord-control.listServers() - List all Discord servers');
      parts.push('  • @discord-control.selectServer("serverName") - Select a server');
      parts.push('  • @discord-control.listChannels("serverName"?) - List channels in server');
      parts.push('  • @discord-control.joinChannel("channelName", "serverName"?) - Join a channel');
      parts.push('  • @discord-control.leaveChannel("channelName", "serverName"?) - Leave a channel');
      parts.push('  • @discord-control.showJoinedChannels() - Show all joined channels');
      
      return parts.join('\n');
    }
    
    private formatGuildsList(): string {
      const parts: string[] = [];
      
      this.availableGuilds.forEach(guild => {
        parts.push(`${guild.name}`);
        parts.push(`  ID: ${guild.id}`);
        if (guild.memberCount) {
          parts.push(`  Members: ${guild.memberCount}`);
        }
        parts.push('');
      });
      
      return parts.join('\n');
    }
    
    private formatChannelsList(channels: ChannelInfo[]): string {
      const parts: string[] = [];
      
      const categorized = this.categorizeChannels(channels);
      categorized.forEach(category => {
        parts.push(`${category.name}:`);
        category.channels.forEach(channel => {
          const joined = this.joinedChannels.has(channel.id) ? ' [JOINED]' : '';
          parts.push(`  #${channel.name}${joined}`);
          parts.push(`    ID: ${channel.id}`);
          if (channel.topic) {
            parts.push(`    Topic: ${channel.topic}`);
          }
        });
        parts.push('');
      });
      
      return parts.join('\n');
    }
    
    private categorizeChannels(channels: ChannelInfo[]): CategoryInfo[] {
      const categories: Map<string, CategoryInfo> = new Map();
      const uncategorized: ChannelInfo[] = [];
      
      // Group by category
      channels.forEach(channel => {
        if (channel.type === 4) { // Category channel
          categories.set(channel.id, {
            id: channel.id,
            name: channel.name,
            channels: []
          });
        }
      });
      
      // Add channels to categories
      channels.forEach(channel => {
        if (channel.type === 0) { // Text channel
          if (channel.parentId && categories.has(channel.parentId)) {
            categories.get(channel.parentId)!.channels.push(channel);
          } else {
            uncategorized.push(channel);
          }
        }
      });
      
      // Sort channels within categories
      categories.forEach(category => {
        category.channels.sort((a, b) => a.position - b.position);
      });
      
      // Build result
      const result = Array.from(categories.values());
      
      // Add uncategorized if any
      if (uncategorized.length > 0) {
        result.unshift({
          id: 'uncategorized',
          name: 'Text Channels',
          channels: uncategorized.sort((a, b) => a.position - b.position)
        });
      }
      
      return result;
    }
    
    private findChannel(channelId: string): ChannelInfo | undefined {
      for (const guildChannels of Object.values(this.availableChannels)) {
        const channel = guildChannels.find(c => c.id === channelId);
        if (channel) return channel;
      }
      return undefined;
    }
    
    private findGuildByName(name: string): GuildInfo | undefined {
      return this.availableGuilds.find(g => 
        g.name.toLowerCase() === name.toLowerCase()
      );
    }
    
    private findChannelByName(channelName: string, serverName: string): ChannelInfo | undefined {
      const guild = this.findGuildByName(serverName);
      if (!guild) return undefined;
      
      const channels = this.availableChannels[guild.id];
      if (!channels) return undefined;
      
      // Remove # prefix if present
      const cleanName = channelName.startsWith('#') ? channelName.slice(1) : channelName;
      
      return channels.find(c => 
        c.type === 0 && c.name.toLowerCase() === cleanName.toLowerCase()
      );
    }
    
    private getSelectedServerName(): string | undefined {
      if (!this.selectedGuildId) return undefined;
      const guild = this.availableGuilds.find(g => g.id === this.selectedGuildId);
      return guild?.name;
    }
    
    private emitActionRegistrations(): void {
      // Emit facets for each registered action
      // TODO: Once VEIL supports changeFacet operations, we can update facets
      // instead of checking for existence. For now, we prevent duplicate addFacet
      // operations by checking if the facet already exists in the current state.
      const actions = [
        {
          name: 'listServers',
          displayName: 'List Discord Servers',
          description: 'Lists all Discord servers the bot has access to',
          parameters: []
        },
        {
          name: 'selectServer',
          displayName: 'Select Server',
          description: 'Selects a Discord server for subsequent operations',
          parameters: [
            { name: 'serverName', type: 'string', required: true, description: 'Name of the server to select' }
          ]
        },
        {
          name: 'listChannels',
          displayName: 'List Channels',
          description: 'Lists channels in the selected or specified server',
          parameters: [
            { name: 'serverName', type: 'string', required: false, description: 'Server name (uses selected server if not provided)' }
          ]
        },
        {
          name: 'joinChannel',
          displayName: 'Join Channel',
          description: 'Joins a Discord channel to receive messages',
          parameters: [
            { name: 'channelName', type: 'string', required: true, description: 'Name of the channel to join' },
            { name: 'serverName', type: 'string', required: false, description: 'Server name (uses selected server if not provided)' }
          ]
        },
        {
          name: 'leaveChannel',
          displayName: 'Leave Channel',
          description: 'Leaves a previously joined Discord channel',
          parameters: [
            { name: 'channelName', type: 'string', required: true, description: 'Name of the channel to leave' },
            { name: 'serverName', type: 'string', required: false, description: 'Server name (optional for disambiguation)' }
          ]
        },
        {
          name: 'showJoinedChannels',
          displayName: 'Show Joined Channels',
          description: 'Displays all currently joined Discord channels',
          parameters: []
        },
        {
          name: 'refreshInstructions',
          displayName: 'Refresh Instructions',
          description: 'Re-emits action registrations and usage instructions',
          parameters: []
        }
      ];
      
      actions.forEach(action => {
        const facetId = `discord-action-${action.name}`;
        
        // Check if facet already exists in current VEIL state
        const veilState = this.element.space?.getVEILState?.();
        const existingFacet = veilState?.getState()?.facets?.get(facetId);
        
        if (!existingFacet) {
          this.addFacet({
            id: facetId,
            type: 'action-definition',
            // No content - action-definition is metadata, not renderable
            displayName: action.displayName,
            attributes: {
              agentGenerated: false,
              toolName: action.name,
              parameters: action.parameters.reduce((acc: any, param: any) => {
                acc[param.name] = param.required ? `<${param.type}>` : `<${param.type}?>`;
                return acc;
              }, {}),
              actionName: action.name,
              category: 'discord-control'
            }
          });
        }
      });
      
      // Also emit a summary facet with all actions
      const actionSummary = actions.map(a => {
        const params = a.parameters.map(p => {
          // Format parameters with quotes for strings
          const paramFormat = p.type === 'string' ? `"${p.name}"` : p.name;
          return p.required ? paramFormat : `${paramFormat}?`;
        }).join(', ');
        return `• @discord-control.${a.name}(${params}) - ${a.description}`;
      }).join('\n');
      
      const summaryId = 'discord-control-actions-summary';
      const veilState = this.element.space?.getVEILState?.();
      if (!veilState?.getState()?.facets?.get(summaryId)) {
        this.addFacet({
          id: summaryId,
          type: 'ambient',
          displayName: 'Discord Control Actions',
          content: `Available Discord Control Panel Actions:\n\n${actionSummary}`,
          attributes: {
            category: 'discord-control',
            actionCount: actions.length
          }
        });
      }
    }
    
    private emitUsageInstructions(): void {
      // Emit a comprehensive help facet
      const instructions = `Discord Control Panel Usage Guide

This component allows you to manage Discord server and channel connections.

Getting Started:
1. Use @discord-control.listServers() to see available Discord servers
2. Use @discord-control.selectServer("Server Name") to choose a server
3. Use @discord-control.listChannels() to see channels in the selected server
4. Use @discord-control.joinChannel("channel-name") to start receiving messages

Examples:
- @discord-control.listServers() - Shows all available servers
- @discord-control.selectServer("My Cool Server") - Selects a specific server
- @discord-control.listChannels() - Lists channels in the selected server
- @discord-control.joinChannel("general") - Joins the #general channel
- @discord-control.joinChannel("dev-chat", "Another Server") - Joins #dev-chat in a specific server
- @discord-control.leaveChannel("general") - Leaves the #general channel
- @discord-control.showJoinedChannels() - Shows all active channel connections

Notes:
- Channel names are case-insensitive
- The # prefix is optional (both "general" and "#general" work)
- Once a server is selected, you don't need to specify it for every operation
- Joined channels persist across frames and are shown with a ✓ mark`;
      
      const instructionsId = 'discord-control-instructions';
      const veilState = this.element.space?.getVEILState?.();
      if (!veilState?.getState()?.facets?.get(instructionsId)) {
        this.addFacet({
          id: instructionsId,
          type: 'ambient',
          displayName: 'Discord Control Panel Help',
          content: instructions,
          attributes: {
            category: 'discord-control',
            persistent: true
          }
        });
      }
    }
  }
  
  return DiscordControlPanelComponent;
}
