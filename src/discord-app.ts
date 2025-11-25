/**
 * Discord Application for Connectome
 *
 * FLEX Architecture - All components extend Component directly with explicit priorities.
 */

import { ConnectomeApplication } from 'connectome-ts/src/host/types';
import { Space } from 'connectome-ts/src/spaces/space';
import { VEILStateManager } from 'connectome-ts/src/veil/veil-state';
import { ComponentRegistry } from 'connectome-ts/src/persistence/component-registry';
import { AgentComponent } from 'connectome-ts/src/agent/agent-component';
import { persistable, persistent } from 'connectome-ts/src/persistence/decorators';
import { Component } from 'connectome-ts/src/spaces/component';
import { SpaceEvent, ExecutionContext } from 'connectome-ts/src/spaces/types';
import { AgentEffector } from 'connectome-ts/src/agent/agent-effector';
import { ActionEffector } from 'connectome-ts/src/spaces/action-effector';
import { ContextTransform } from 'connectome-ts/src/hud/context-transform';
import { ComponentManager } from 'connectome-ts/src/spaces/component-manager';
import type { Facet, ReadonlyVEILState } from 'connectome-ts/src';
import { updateStateFacets } from 'connectome-ts/src/helpers/factories';

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
 * FLEX Component: Discord Message Receptor
 *
 * Handles all Discord event-to-facet transformations:
 * - discord:connected → config facets + connection event
 * - discord:message → message facets + agent activations
 * - discord:history-sync → offline edit/delete detection
 * - discord:messageUpdate → message edit handling
 * - discord:messageDelete → message deletion handling
 *
 * Priority 100: Standard receptor priority
 */
class DiscordMessageReceptor extends Component {
  priority = 100;

  execute(context: ExecutionContext): void {
    const { event, state } = context;

    switch (event.topic) {
      case 'discord:connected':
        this.handleConnected(event, state);
        break;
      case 'discord:message':
        this.handleMessage(event, state);
        break;
      case 'discord:history-sync':
        this.handleHistorySync(event, state);
        break;
      case 'discord:messageUpdate':
        this.handleMessageUpdate(event, state);
        break;
      case 'discord:messageDelete':
        this.handleMessageDelete(event, state);
        break;
    }
  }

  private handleConnected(event: SpaceEvent, state: ReadonlyVEILState): void {
    console.log('[DiscordMessageReceptor] Processing discord:connected event');
    const payload = event.payload as any;

    // Store bot user ID in a persistent config facet for easy access
    if (payload.botUserId) {
      console.log(`[DiscordMessageReceptor] Storing bot user ID: ${payload.botUserId}`);
      for (const delta of updateStateFacets('discord-config', { botUserId: payload.botUserId }, state)) {
        this.addOperation(delta);
      }
    }

    // Also create the connection event facet
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `discord-connected-${Date.now()}`,
        type: 'event',
        content: 'Discord connected',
        state: {
          source: 'discord',
          eventType: 'discord-connected'
        },
        attributes: payload as Record<string, any>
      }
    });
  }

  private handleMessage(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const { channelId, channelName, author, authorId, content, rawContent, mentions, attachments, reply, messageId, streamId, streamType, isBot } = payload;

    // Check if we've already processed this message (de-dup against VEIL)
    const lastReadFacet = state.facets.get(`discord-lastread-${channelId}`);
    const lastMessageId = lastReadFacet?.state?.value;

    if (lastMessageId && this.isOlderOrEqual(messageId, lastMessageId)) {
      console.log(`[DiscordMessageReceptor] Skipping old/duplicate message ${messageId}`);
      return;
    }

    console.log(`[DiscordMessageReceptor] Processing message from ${author}: "${content}"${reply ? ' (reply)' : ''}`);

    // Retrieve bot user ID from VEIL state
    const botConfigFacet = state.facets.get('discord-config-botUserId');
    const botUserId = botConfigFacet?.state?.value;

    if (!botUserId) {
      console.warn('[DiscordMessageReceptor] Bot user ID not found in VEIL state, skipping activation checks');
    }

    // Format content with reply syntax if this is a reply
    let formattedContent = content;
    let replyToUsername = null;

    if (reply) {
      const referencedFacet = state.facets.get(`discord-msg-${reply.messageId}`);
      if (referencedFacet && referencedFacet.state?.metadata?.author) {
        replyToUsername = referencedFacet.state.metadata.author;
      } else if (reply.author) {
        replyToUsername = reply.author;
      }

      if (replyToUsername) {
        formattedContent = `<reply:@${replyToUsername}> ${content}`;
      }
    }

    // Create speech facet as nested child
    const speechFacet: any = {
      id: `speech-${messageId}`,
      type: 'speech',
      content: formattedContent,
      streamId,
      streamType,
      state: {
        speakerId: `discord:${authorId}`,
        speaker: author,
        metadata: { attachments }
      }
    };

    // If this is from the bot itself, mark it as agent-generated
    if (authorId === botUserId) {
      speechFacet.agentId = 'connectome';
      speechFacet.agentName = 'Connectome';
    }

    // Create message facet with speech nested inside
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `discord-msg-${messageId}`,
        type: 'event',
        state: {
          source: 'discord',
          eventType: 'discord-message',
          metadata: { channelName, author, authorId, isBot, rawContent, mentions, attachments, reply }
        },
        streamId,
        streamType,
        attributes: { channelId, messageId, mentions, reply },
        children: [speechFacet]
      }
    });

    // Update lastRead in VEIL
    for (const delta of updateStateFacets('discord-lastread', { [channelId]: messageId }, state)) {
      this.addOperation(delta);
    }

    // Activate agent if the bot is mentioned or replied to
    if (botUserId) {
      const botMentioned = mentions?.users?.some((u: any) => u.id === botUserId);
      const replyingToBot = reply?.authorId === botUserId;
      const activatePattern = /<activate\s+([^>]+)>/i;
      const activateMatch = rawContent?.match(activatePattern);
      const fallbackActivate = activateMatch !== null && activateMatch !== undefined;

      if (botMentioned || replyingToBot || fallbackActivate) {
        const reason = botMentioned ? 'bot_mentioned' : replyingToBot ? 'bot_replied_to' : 'fallback_activate';
        console.log(`[DiscordMessageReceptor] Creating agent activation (${reason})`);

        const { createAgentActivation } = require('connectome-ts/src/helpers/factories');

        this.addOperation({
          type: 'addFacet',
          facet: createAgentActivation(reason, {
            id: `activation-${messageId}`,
            priority: 'normal',
            source: 'discord-message',
            sourceAgentId: author.id,
            channelId,
            messageId,
            author,
            streamRef: { streamId, streamType, metadata: { channelId, channelName } }
          })
        });
      }
    }
  }

  private isOlderOrEqual(messageId: string, lastMessageId: string): boolean {
    try {
      return BigInt(messageId) <= BigInt(lastMessageId);
    } catch {
      return false;
    }
  }

  private handleHistorySync(event: SpaceEvent, state: ReadonlyVEILState): void {
    const { channelId, channelName, messages } = event.payload as any;

    console.log(`[DiscordMessageReceptor] Syncing ${messages.length} messages for channel ${channelId}`);

    // Build map of current Discord state
    const discordMessages = new Map(messages.map((m: any) => [m.messageId, m]));

    // Find all Discord message facets for this channel in VEIL
    const veilMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' &&
        (f as any).state?.eventType === 'discord-message' &&
        (f as any).attributes?.channelId === channelId
    );

    let deletedCount = 0;
    let editedCount = 0;
    const newMessages: any[] = [];

    console.log(`[DiscordMessageReceptor] Found ${veilMessages.length} existing messages in VEIL, ${messages.length} in history`);

    for (const veilMsg of veilMessages) {
      const messageId = (veilMsg as any).attributes.messageId;
      const speechFacet = (veilMsg as any).children?.[0];
      const veilContent = speechFacet?.content || '';
      const discordMsg = discordMessages.get(messageId) as any;

      if (!discordMsg) {
        // Message was DELETED offline
        console.log(`[DiscordMessageReceptor] Message ${messageId} deleted offline`);
        deletedCount++;

        this.addOperation({ type: 'removeFacet', id: veilMsg.id });
        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `discord-offline-delete-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was deleted while offline]`,
            state: { source: 'discord-history-sync', eventType: 'discord-message-deleted-offline', metadata: { messageId, channelId } },
            attributes: { messageId, channelId },
            ephemeral: true
          }
        });
      } else if (this.extractContent(veilContent) !== discordMsg.content) {
        // Message was EDITED offline
        console.log(`[DiscordMessageReceptor] Message ${messageId} edited offline`);
        editedCount++;

        if (speechFacet) {
          this.addOperation({
            type: 'rewriteFacet',
            id: speechFacet.id,
            changes: { content: `${discordMsg.author}: ${discordMsg.content}` }
          });
        }

        this.addOperation({
          type: 'rewriteFacet',
          id: veilMsg.id,
          changes: {
            state: {
              source: 'discord',
              eventType: 'discord-message',
              metadata: { ...((veilMsg as any).state?.metadata || {}), rawContent: discordMsg.rawContent, mentions: discordMsg.mentions }
            },
            attributes: { ...((veilMsg as any).attributes || {}), mentions: discordMsg.mentions }
          }
        });

        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `discord-offline-edit-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was edited while offline]`,
            state: {
              source: 'discord-history-sync',
              eventType: 'discord-message-edited-offline',
              metadata: { messageId, channelId, oldContent: this.extractContent(veilContent), newContent: discordMsg.content }
            },
            attributes: { messageId, channelId }
          }
        });
      }
    }

    // Find messages in Discord history that aren't in VEIL yet
    const veilMessageIds = new Set(veilMessages.map(v => (v as any).attributes.messageId));
    for (const msg of messages) {
      if (!veilMessageIds.has(msg.messageId)) {
        newMessages.push(msg);
      }
    }

    console.log(`[DiscordMessageReceptor] ${editedCount} edits, ${deletedCount} deletions, ${newMessages.length} new messages`);

    // Create a single parent facet for new history messages
    if (newMessages.length > 0) {
      const children: any[] = [];

      for (const msg of newMessages) {
        const speechFacet = {
          id: `speech-${msg.messageId}`,
          type: 'speech',
          content: msg.content,
          state: { speakerId: `discord:${msg.authorId}`, speaker: msg.author }
        };

        children.push({
          id: `discord-msg-${msg.messageId}`,
          type: 'event',
          state: {
            source: 'discord',
            eventType: 'discord-message',
            metadata: { channelName, author: msg.author, authorId: msg.authorId, isBot: msg.isBot, rawContent: msg.rawContent, mentions: msg.mentions }
          },
          attributes: { channelId, messageId: msg.messageId, mentions: msg.mentions },
          children: [speechFacet]
        });
      }

      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `discord-history-${channelId}-${Date.now()}`,
          type: 'event',
          displayName: 'discord-history',
          state: { source: 'discord', eventType: 'discord-history-dump', metadata: { channelId, channelName, messageCount: newMessages.length } },
          attributes: { channelId, messageCount: newMessages.length },
          children
        }
      });
    }
  }

  private extractContent(fullContent: string | undefined): string {
    if (!fullContent) return '';
    const match = fullContent.match(/^[^:]+: (.+)$/);
    return match ? match[1] : fullContent;
  }

  private handleMessageUpdate(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const { messageId, content, rawContent, oldContent, rawOldContent, mentions, author, authorId, channelName, isBot } = payload;

    console.log(`[DiscordMessageReceptor] Message ${messageId} edited by ${author}`);

    const facetId = `discord-msg-${messageId}`;
    const speechFacetId = `speech-${messageId}`;

    if (state.facets.has(facetId)) {
      if (state.facets.has(speechFacetId)) {
        this.addOperation({
          type: 'rewriteFacet',
          id: speechFacetId,
          changes: { content: `${author}: ${content}` }
        });
      }

      this.addOperation({
        type: 'rewriteFacet',
        id: facetId,
        changes: {
          state: { source: 'discord', eventType: 'discord-message', metadata: { channelName, author, authorId, isBot, rawContent, mentions } },
          attributes: { mentions }
        }
      });

      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `discord-edit-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author} edited their message in #${channelName}`,
          state: {
            source: 'discord',
            eventType: 'discord-message-edited',
            metadata: { messageId, author, authorId, channelName, oldContent, newContent: content, rawOldContent, rawNewContent: rawContent, mentions }
          },
          attributes: { messageId, oldContent, newContent: content, author, mentions }
        }
      });
    }
  }

  private handleMessageDelete(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const { messageId, author, channelName } = payload;

    console.log(`[DiscordMessageReceptor] Message ${messageId} deleted`);

    const facetId = `discord-msg-${messageId}`;

    if (state.facets.has(facetId)) {
      this.addOperation({ type: 'removeFacet', id: facetId });

      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `discord-delete-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author || 'Someone'} deleted their message in #${channelName || 'a channel'}`,
          state: {
            source: 'discord',
            eventType: 'discord-message-deleted',
            metadata: { messageId, author, channelName, deletedFacetId: facetId }
          },
          attributes: { messageId, author, deletedFacetId: facetId }
        }
      });
    }
  }
}  // End of DiscordMessageReceptor class
/**
 * FLEX Component: Discord Infrastructure
 *
 * Watches for required components to be mounted and triggers DiscordAfferent creation.
 *
 * Priority 150: Early transform priority (after receptors at 100)
 */
class DiscordInfrastructureTransform extends Component {
  priority = 150;

  // Discord configuration (injected via component config)
  private discordConfig?: any;

  // Track which components we're waiting for (simplified for merged receptor)
  private requiredComponents = new Set([
    'DiscordMessageReceptor',
    'DiscordEffector',
    'AgentEffector',
    'ActionEffector',
    'ContextTransform'
  ]);

  private hasTriggered = false;

  execute(context: ExecutionContext): void {
    if (this.hasTriggered) return;

    if (!this.discordConfig) {
      console.log('[DiscordInfrastructure] Waiting for config...');
      return;
    }

    const space = this.space;
    if (!space) {
      console.log('[DiscordInfrastructure] Space not available yet...');
      return;
    }

    const components = space.components || [];
    const mountedTypes = new Set(components.map((c: any) => c.constructor.name));

    const allReady = [...this.requiredComponents].every(type => mountedTypes.has(type));

    if (!allReady) {
      console.log('[DiscordInfrastructure] Waiting for components... Have:', Array.from(mountedTypes), 'Need:', Array.from(this.requiredComponents));
      return;
    }

    const hasDiscordAfferent = components.some((c: any) => c.constructor.name === 'DiscordAfferent');
    if (hasDiscordAfferent) {
      console.log('[DiscordInfrastructure] DiscordAfferent already exists, skipping creation');
      this.hasTriggered = true;
      return;
    }

    console.log('[DiscordInfrastructure] All components ready - creating DiscordAfferent via component:add');
    this.hasTriggered = true;

    this.emit({
      topic: 'component:add',
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordAfferent',
        componentId: 'discord:DiscordAfferent',
        config: {
          host: this.discordConfig.host,
          path: this.discordConfig.path,
          guild: this.discordConfig.guild,
          agent: this.discordConfig.agent,
          token: this.discordConfig.token,
          autoJoinChannels: this.discordConfig.autoJoinChannels || [],
          _axonMetadata: {
            moduleUrl: this.discordConfig.moduleUrl,
            manifestUrl: this.discordConfig.manifestUrl
          }
        }
      }
    });
  }
}

/**
 * FLEX Component: Discord Effector
 *
 * Handles all Discord side effects:
 * - Auto-join channels when connected
 * - Send typing indicators when agent activates
 * - Send agent speech to Discord
 *
 * Priority 300: Standard effector priority
 */
class DiscordEffector extends Component {
  priority = 300;

  private discordAfferent?: any;
  private channels: string[] = [];

  onMount(): void {
    const space = this.space;
    if (space) {
      this.discordAfferent = space.components.find((c: any) =>
        c.constructor.name === 'DiscordAfferent'
      );
      console.log(`[DiscordEffector] Found DiscordAfferent:`, !!this.discordAfferent);
    }
  }

  execute(context: ExecutionContext): void {
    const { state, frame } = context;

    // Lazy lookup for DiscordAfferent
    if (!this.discordAfferent) {
      const space = this.space;
      if (space) {
        this.discordAfferent = space.components.find((c: any) =>
          c.constructor.name === 'DiscordAfferent'
        );
      }
    }

    // Process frame deltas for facets we care about
    if (frame && frame.deltas) {
      for (const delta of frame.deltas) {
        if (delta.type === 'addFacet') {
          const facet = delta.facet;

          // Handle discord:connected - auto-join channels
          if (facet.type === 'event' && (facet as any).state?.eventType === 'discord-connected') {
            this.handleConnected(state);
          }

          // Handle agent-activation - send typing indicator
          if (facet.type === 'agent-activation') {
            this.handleActivation(facet, state);
          }

          // Handle speech - send to Discord
          if (facet.type === 'speech') {
            this.handleSpeech(facet, state);
          }
        }
      }
    }
  }

  private handleConnected(state: ReadonlyVEILState): void {
    if (!this.discordAfferent || !this.channels || this.channels.length === 0) return;

    console.log('🤖 Discord connected! Auto-joining channels:', this.channels);

    for (const channelId of this.channels) {
      console.log(`📢 Calling join for channel: ${channelId}`);

      if (this.discordAfferent.join && typeof this.discordAfferent.join === 'function') {
        this.discordAfferent.join({ channelId }).catch((err: any) =>
          console.error(`Failed to join channel ${channelId}:`, err)
        );
      } else if (this.discordAfferent.actions?.has('join')) {
        this.discordAfferent.actions.get('join')({ channelId }).catch((err: any) =>
          console.error(`Failed to join channel ${channelId}:`, err)
        );
      }
    }
  }

  private handleActivation(facet: Facet, state: ReadonlyVEILState): void {
    const activation = facet as any;
    const channelId = activation.state?.channelId || activation.state?.metadata?.channelId;

    if (!channelId || !this.discordAfferent?.sendTyping) return;

    console.log(`[DiscordEffector] Sending typing indicator to channel: ${channelId}`);

    this.discordAfferent.sendTyping({ channelId }).catch((err: any) =>
      console.error(`Failed to send typing indicator:`, err)
    );
  }

  private handleSpeech(facet: Facet, state: ReadonlyVEILState): void {
    const speech = facet as any;
    const streamId = speech.streamId;
    let content = speech.content;

    // Check if this is for Discord
    if (!streamId || !streamId.startsWith('discord:')) return;

    console.log(`[DiscordEffector] Processing speech for stream: ${streamId}`);

    // Check for reply syntax: <reply:@username> message
    const replyMatch = content.match(/^<reply:@([^>]+)>\s*/);
    let replyToMessageId = null;

    if (replyMatch) {
      const replyToUsername = replyMatch[1];
      content = content.substring(replyMatch[0].length);
      console.log(`[DiscordEffector] Detected reply to @${replyToUsername}`);
      replyToMessageId = this.inferReplyTarget(replyToUsername, speech, state);
    }

    // Find the channel ID from latest discord message
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message'
    );

    if (discordMessages.length === 0) {
      console.warn('[DiscordEffector] No discord-message facets found');
      return;
    }

    const latestMessage = discordMessages[discordMessages.length - 1] as any;
    const channelId = latestMessage.attributes?.channelId;

    if (!channelId) {
      console.warn('[DiscordEffector] No channelId in message facet');
      return;
    }

    const sendParams: any = { channelId, message: content };
    if (replyToMessageId) {
      sendParams.replyTo = replyToMessageId;
      console.log(`[DiscordEffector] Sending as reply to message ${replyToMessageId}`);
    }

    console.log(`[DiscordEffector] Sending to channel ${channelId}: "${content}"`);

    if (!this.discordAfferent) {
      console.error('[DiscordEffector] DiscordAfferent not available');
      return;
    }

    if (this.discordAfferent.send && typeof this.discordAfferent.send === 'function') {
      this.discordAfferent.send(sendParams)
        .then(() => console.log(`[DiscordEffector] Successfully sent message`))
        .catch((err: any) => console.error(`Failed to send to Discord:`, err));
    } else if (this.discordAfferent.actions?.has('send')) {
      this.discordAfferent.actions.get('send')(sendParams)
        .then(() => console.log(`[DiscordEffector] Successfully sent message`))
        .catch((err: any) => console.error(`Failed to send to Discord:`, err));
    }
  }

  private inferReplyTarget(username: string, speech: any, state: ReadonlyVEILState): string | null {
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message'
    ) as any[];

    // Heuristic 1: Check the activation event
    const activations = Array.from(state.facets.values()).filter(
      f => f.type === 'agent-activation' && (f as any).state?.streamRef?.streamId === speech.streamId
    ) as any[];

    if (activations.length > 0) {
      const latestActivation = activations[activations.length - 1];
      const triggerMessageId = latestActivation.state?.messageId;
      if (triggerMessageId) {
        const triggerMessage = discordMessages.find(m => m.attributes?.messageId === triggerMessageId);
        if (triggerMessage && triggerMessage.state?.metadata?.author === username) {
          console.log(`[DiscordEffector] Reply target (activation): ${triggerMessageId}`);
          return triggerMessageId;
        }
      }
    }

    // Heuristic 2: Find last message from username that mentioned/replied to bot
    const botConfigFacet = state.facets.get('discord-config-botUserId');
    const botUserId = botConfigFacet?.state?.value;

    for (let i = discordMessages.length - 1; i >= 0; i--) {
      const msg = discordMessages[i];
      if (msg.state?.metadata?.author !== username) continue;

      const mentions = msg.state?.metadata?.mentions;
      if (mentions?.users?.some((u: any) => u.id === botUserId)) {
        console.log(`[DiscordEffector] Reply target (mentioned bot): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }

      const reply = msg.state?.metadata?.reply;
      if (reply?.authorId === botUserId) {
        console.log(`[DiscordEffector] Reply target (replied to bot): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }
    }

    // Heuristic 3: Find last message from username
    for (let i = discordMessages.length - 1; i >= 0; i--) {
      const msg = discordMessages[i];
      if (msg.state?.metadata?.author === username) {
        console.log(`[DiscordEffector] Reply target (last from user): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }
    }

    console.log(`[DiscordEffector] No reply target found for @${username}`);
    return null;
  }
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
    // Subscribe to discord connected event
    this.subscribe('discord:connected');
  }
  
  async handleEvent(event: SpaceEvent): Promise<void> {
    console.log('🔔 DiscordAutoJoinComponent received event:', event.topic, 'from:', event.source);
    
    // Always try to join channels on discord:connected
    if (event.topic === 'discord:connected') {
      console.log('🤖 Discord connected! Auto-joining channels:', this.channels);
      
      // Find DiscordAfferent directly in space
      const space = this.space;
      const discordAfferent = space.components.find((c: any) => c.constructor.name === 'DiscordAfferent') as any;
      
      if (discordAfferent) {
        console.log('Found DiscordAfferent');
        for (const channelId of this.channels) {
          console.log(`📢 Requesting to join channel: ${channelId}`);
          
          if (typeof discordAfferent.join === 'function') {
             discordAfferent.join({ channelId });
          }
        }
        this.hasJoined = true;
      } else {
        console.log('DiscordAfferent not found!');
      }
    }
  }
}

export class DiscordApplication implements ConnectomeApplication {
  constructor(private config: DiscordAppConfig) {}
  
  async createSpace(hostRegistry?: Map<string, any>, lifecycleId?: string, spaceId?: string): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry, lifecycleId, spaceId);
    return { space, veilState };
  }
  
  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🎮 Initializing Discord application (fresh start)...');
    
    // Register all components
    this.getComponentRegistry();

    // Add ComponentManager first - handles component:add events
    // console.log('🔧 Adding ComponentManager...');
    // space.addComponent(new ComponentManager(), 'ComponentManager');
    console.log('🔧 ComponentManager should be provided by Host');

    const botToken = (this.config as any).botToken || '';
        const modulePort = this.config.discord.modulePort || 8080;

    // Build Discord configuration
    const discordConfig = {
      host: this.config.discord.host,
      path: '/ws',
      guild: this.config.discord.guild,
      agent: this.config.agentName,
      token: botToken,
      autoJoinChannels: this.config.discord.autoJoinChannels || [],
      moduleUrl: `http://localhost:${modulePort}/modules/discord-afferent/module`,
      manifestUrl: `http://localhost:${modulePort}/modules/discord-afferent/manifest`
    };

    // STEP 1: Add DiscordInfrastructureTransform (via component:add event to test ComponentManager)
    console.log('🔧 Adding DiscordInfrastructureTransform...');
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordInfrastructureTransform',
        componentId: 'discord:DiscordInfrastructureTransform',
        config: { discordConfig }
      }
    });


    // STEP 2: Add FLEX components (merged for performance)
    console.log('➕ Adding Discord FLEX components...');

    // Add merged DiscordMessageReceptor (handles all discord events → facets)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordMessageReceptor',
        componentId: 'discord:DiscordMessageReceptor',
        config: {}
      }
    });

    // Add merged DiscordEffector (handles auto-join, typing, speech)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordEffector',
        componentId: 'discord:DiscordEffector',
        config: {
          channels: this.config.discord.autoJoinChannels || []
        }
      }
    });

    // Add AgentEffector, ActionEffector, and ContextTransform
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'AgentEffector',
        componentId: 'discord:AgentEffector',
        config: { agentElementId: 'discord-agent' } // Legacy config, but still used for ID lookup
      }
    });

    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ActionEffector',
        componentId: 'discord:ActionEffector',
        config: {}
      }
    });

    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ContextTransform',
        componentId: 'discord:ContextTransform',
        config: {}
      }
    });

    // Wait for infrastructure components to be created
    await new Promise(resolve => setTimeout(resolve, 100));

    console.log('✅ Infrastructure components added - Discord component will be created when ready');

    // Check for existing AgentComponent
    let existingAgentComponent = space.getComponentById('discord-agent:AgentComponent');

    if (!existingAgentComponent) {
      console.log('🆕 Creating agent component');
      
        const agentConfig = {
          name: this.config.agentName,
          systemPrompt: this.config.systemPrompt,
          autoActionRegistration: true
        };
      
      space.emit({
        topic: 'component:add',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          componentType: 'AgentComponent',
          componentId: 'discord-agent:AgentComponent',
          config: { agentConfig } 
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      console.log('✅ Found existing agent component');
    }
    
    // Subscribe to agent response events
    space.subscribe('agent:frame-ready');

    // Check for box-dispenser component
    let existingBoxComponent = space.getComponentById('box-dispenser:AgentComponent');

    if (!existingBoxComponent) {
      console.log('📦 Creating Box Dispenser component');
      
      const boxAgentConfig = {
        name: 'Box Dispenser',
        systemPrompt: 'You are a helpful box dispenser. You dispense boxes. When asked, you cheerfully dispense a box and describe it.',
        autoActionRegistration: true
      };
    
      space.emit({
        topic: 'component:add',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          componentType: 'AgentComponent',
          componentId: 'box-dispenser:AgentComponent',
          config: { agentConfig: boxAgentConfig }
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      console.log('✅ Found existing Box Dispenser component');
    }

    // Check for discord-control component
    let existingControlComponent = space.getComponentById('discord-control:DiscordControlPanelComponent');

    if (!existingControlComponent) {
      console.log('📋 Creating Discord control panel component');
      
      space.emit({
        topic: 'component:add',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          componentType: 'DiscordControlPanelComponent',
          componentId: 'discord-control:DiscordControlPanelComponent',
          config: {
            _axonMetadata: {
              moduleUrl: `http://localhost:${modulePort}/modules/discord-control-panel/module`,
              manifestUrl: `http://localhost:${modulePort}/modules/discord-control-panel/manifest`
            }
          }
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      console.log('✅ Found existing Discord control panel component');
    }

    // Check for element-control component
    let existingElementControlComponent = space.getComponentById('element-control:ElementControlComponent');

    if (!existingElementControlComponent) {
      console.log('🎮 Creating Element control panel component');
      
      space.emit({
        topic: 'component:add',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          componentType: 'ElementControlComponent',
          componentId: 'element-control:ElementControlComponent',
          config: {
            _axonMetadata: {
              moduleUrl: `http://localhost:${modulePort}/modules/element-control/module`,
              manifestUrl: `http://localhost:${modulePort}/modules/element-control/manifest`
            }
          }
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      console.log('✅ Found existing Element control panel');
    }
    
    console.log('✅ Discord application initialized');
  }
  
  getComponentRegistry(): typeof ComponentRegistry {
    const registry = ComponentRegistry;

    // Register all FLEX components
    registry.register('AgentComponent', AgentComponent);
    registry.register('DiscordAutoJoinComponent', DiscordAutoJoinComponent);

    // Register FLEX infrastructure
    registry.register('ComponentManager', ComponentManager);
    registry.register('DiscordInfrastructureTransform', DiscordInfrastructureTransform);

    // Merged FLEX receptor (handles all discord events)
    registry.register('DiscordMessageReceptor', DiscordMessageReceptor);

    // Merged FLEX effector (handles auto-join, typing, speech)
    registry.register('DiscordEffector', DiscordEffector);

    // Core components
    registry.register('AgentEffector', AgentEffector);
    registry.register('ActionEffector', ActionEffector);
    registry.register('ContextTransform', ContextTransform);

    return registry;
  }
  
  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Discord application started!');
    console.log('✅ Discord application ready - waiting for infrastructure to create Discord component');
  }
  
  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored from snapshot');
    console.log('✅ All connections re-established after restoration');
  }
}
