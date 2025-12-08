/**
 * Discord Application for Connectome (Consolidated)
 *
 * FLEX Architecture with explicit multi-constraint ordering.
 *
 * Component structure:
 * - DiscordReceptor: All inbound Discord handling + infrastructure setup
 * - DiscordEffector: All outbound Discord actions (after AgentComponent)
 */

import { ConnectomeApplication } from 'connectome-ts/src/host/types';
import { Space } from 'connectome-ts/src/spaces/space';
import { VEILStateManager } from 'connectome-ts/src/veil/veil-state';
import { ComponentRegistry } from 'connectome-ts/src/persistence/component-registry';
import { AgentComponent } from 'connectome-ts/src/agent/agent-component';
import { Component } from 'connectome-ts/src/spaces/component';
import { SpaceEvent, ExecutionContext } from 'connectome-ts/src/spaces/types';
import { ComponentManager } from 'connectome-ts/src/spaces/component-manager';
import { AxonLoaderComponent } from 'connectome-ts/src/components/axon-loader';
import type { Facet, ReadonlyVEILState } from 'connectome-ts/src';
import { updateStateFacets } from 'connectome-ts/src/helpers/factories';
import {
  priorityConstraint,
  ComponentPriority,
  afterComponentType,
  beforeComponentType
} from 'connectome-ts/src/spaces/constraints';

// Lua Scripting System
import {
  ScriptExecutorEffector,
  createToolRegistry,
  ToolRegistry,
  isToolCallFacet,
  createToolCallResultFacet,
} from 'connectome-ts/src/scripting';

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
 * DiscordReceptor - Unified inbound Discord component
 *
 * Handles:
 * - Discord event → VEIL facet transformations (connected, message, history-sync, update, delete)
 * - Infrastructure setup (waits for dependencies, creates DiscordAfferent)
 * - System prompt emission
 *
 * Constraints:
 * - Priority 100 (standard receptor)
 * - Must run before DiscordEffector (we create facets it reads)
 * - Must run before AgentComponent (we create activations it processes)
 */
class DiscordReceptor extends Component {
  constraints = [
    priorityConstraint(ComponentPriority.RECEPTOR),
    beforeComponentType('DiscordEffector'),
    beforeComponentType('AgentComponent')
  ];

  // Infrastructure state
  private discordConfig?: any;
  private agentSystemPrompts?: Array<{ agentName: string; systemPrompt: string }>;
  private infrastructureTriggered = false;
  private requiredComponents = new Set(['DiscordEffector', 'ActionEffector', 'ContextTransform']);

  execute(context: ExecutionContext): void {
    const { event, state } = context;

    // Phase 1: Handle Discord events → create facets
    this.handleDiscordEvents(event, state);

    // Phase 2: Infrastructure check (create DiscordAfferent when ready)
    this.checkInfrastructure();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1: Discord Event Handling (Receptor Logic)
  // ═══════════════════════════════════════════════════════════════════════════

  private handleDiscordEvents(event: SpaceEvent, state: ReadonlyVEILState): void {
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
    console.log('[DiscordReceptor] Processing discord:connected event');
    const payload = event.payload as any;

    // Store bot user ID
    if (payload.botUserId) {
      console.log(`[DiscordReceptor] Storing bot user ID: ${payload.botUserId}`);
      for (const delta of updateStateFacets('discord-config', { botUserId: payload.botUserId }, state)) {
        this.addOperation(delta);
      }
    }

    // Emit identity system prompt
    const botName = payload.botDisplayName || payload.botUsername || payload.agentName;
    if (botName) {
      console.log(`[DiscordReceptor] Emitting identity facet for bot: ${botName}`);
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: 'system-prompt:identity',
          type: 'ambient',
          content: `You are connected to Discord as ${botName}.`
        }
      });
    }

    // Create connection event facet
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `discord-connected-${Date.now()}`,
        type: 'event',
        content: 'Discord connected',
        state: { source: 'discord', eventType: 'discord-connected' },
        attributes: payload as Record<string, any>
      }
    });
  }

  private handleMessage(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const { channelId, channelName, author, authorId, content, rawContent, mentions, attachments, reply, messageId, streamId, streamType, isBot } = payload;

    // De-dup check
    const lastReadFacet = state.facets.get(`discord-lastread-${channelId}`);
    const lastMessageId = lastReadFacet?.state?.value;
    if (lastMessageId && this.isOlderOrEqual(messageId, lastMessageId)) {
      return;
    }

    console.log(`[DiscordReceptor] Processing message from ${author}: "${content}"`);

    // Get bot user ID for activation checks
    const botConfigFacet = state.facets.get('discord-config-botUserId');
    const botUserId = botConfigFacet?.state?.value;

    // Format content with reply syntax
    let formattedContent = content;
    if (reply) {
      const referencedFacet = state.facets.get(`discord-msg-${reply.messageId}`);
      const replyToUsername = referencedFacet?.state?.metadata?.author || reply.author;
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
      state: { speakerId: `discord:${authorId}`, speaker: author, metadata: { attachments } }
    };

    if (authorId === botUserId) {
      speechFacet.agentId = 'connectome';
      speechFacet.agentName = 'Connectome';
    }

    // Create message facet with speech nested
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `discord-msg-${messageId}`,
        type: 'event',
        state: { source: 'discord', eventType: 'discord-message', metadata: { channelName, author, authorId, isBot, rawContent, mentions, attachments, reply } },
        streamId,
        streamType,
        attributes: { channelId, messageId, mentions, reply },
        children: [speechFacet]
      }
    });

    // Update lastRead
    for (const delta of updateStateFacets('discord-lastread', { [channelId]: messageId }, state)) {
      this.addOperation(delta);
    }

    // Create activation if bot mentioned/replied to
    if (botUserId) {
      const botMentioned = mentions?.users?.some((u: any) => u.id === botUserId);
      const replyingToBot = reply?.authorId === botUserId;
      const activateMatch = rawContent?.match(/<activate\s+([^>]+)>/i);

      if (botMentioned || replyingToBot || activateMatch) {
        const reason = botMentioned ? 'bot_mentioned' : replyingToBot ? 'bot_replied_to' : 'fallback_activate';
        console.log(`[DiscordReceptor] Creating agent activation (${reason})`);

        const { createAgentActivation } = require('connectome-ts/src/helpers/factories');
        this.addOperation({
          type: 'addFacet',
          facet: createAgentActivation(reason, {
            id: `activation-${messageId}`,
            priority: 'normal',
            source: 'discord-message',
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
    const { channelId, channelName, guildId, guildName, messages } = event.payload as any;
    console.log(`[DiscordReceptor] Syncing ${messages.length} messages for channel ${channelId}`);

    const discordMessages = new Map(messages.map((m: any) => [m.messageId, m]));
    const veilMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message' && (f as any).attributes?.channelId === channelId
    );

    let deletedCount = 0, editedCount = 0;
    const newMessages: any[] = [];

    // Check for offline edits/deletes
    for (const veilMsg of veilMessages) {
      const messageId = (veilMsg as any).attributes.messageId;
      const speechFacet = (veilMsg as any).children?.[0];
      const veilContent = speechFacet?.content || '';
      const discordMsg = discordMessages.get(messageId) as any;

      if (!discordMsg) {
        deletedCount++;
        this.addOperation({ type: 'removeFacet', id: veilMsg.id });
        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `discord-offline-delete-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was deleted while offline]`,
            state: { source: 'discord-history-sync', eventType: 'discord-message-deleted-offline', metadata: { messageId, channelId } },
            ephemeral: true
          }
        });
      } else if (this.extractContent(veilContent) !== discordMsg.content) {
        editedCount++;
        if (speechFacet) {
          this.addOperation({ type: 'rewriteFacet', id: speechFacet.id, changes: { content: `${discordMsg.author}: ${discordMsg.content}` } });
        }
        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `discord-offline-edit-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was edited while offline]`,
            state: { source: 'discord-history-sync', eventType: 'discord-message-edited-offline', metadata: { messageId, channelId } }
          }
        });
      }
    }

    // Find new messages
    const veilMessageIds = new Set(veilMessages.map(v => (v as any).attributes.messageId));
    for (const msg of messages) {
      if (!veilMessageIds.has(msg.messageId)) {
        newMessages.push(msg);
      }
    }

    console.log(`[DiscordReceptor] ${editedCount} edits, ${deletedCount} deletions, ${newMessages.length} new messages`);

    // Create history dump facet for new messages
    if (newMessages.length > 0) {
      const historyFacetId = `discord-history-${channelId}`;
      const children: any[] = [
        { id: `${historyFacetId}-channel`, type: 'metadata', displayName: 'channel', content: `#${channelName || 'unknown'}` },
        { id: `${historyFacetId}-server`, type: 'metadata', displayName: 'server', content: guildName || 'unknown' }
      ];

      for (const msg of newMessages) {
        children.push({
          id: `discord-msg-${msg.messageId}`,
          type: 'event',
          state: { source: 'discord', eventType: 'discord-message', metadata: { channelName, author: msg.author, authorId: msg.authorId, isBot: msg.isBot } },
          attributes: { channelId, messageId: msg.messageId },
          children: [{ id: `speech-${msg.messageId}`, type: 'speech', content: msg.content, state: { speakerId: `discord:${msg.authorId}`, speaker: msg.author } }]
        });
      }

      this.addOperation({
        type: 'addFacet',
        facet: { id: historyFacetId, type: 'event', displayName: 'discord-history', state: { source: 'discord', eventType: 'discord-history-dump' }, children }
      });
    }
  }

  private extractContent(fullContent: string | undefined): string {
    if (!fullContent) return '';
    const match = fullContent.match(/^[^:]+: (.+)$/);
    return match ? match[1] : fullContent;
  }

  private handleMessageUpdate(event: SpaceEvent, state: ReadonlyVEILState): void {
    const { messageId, content, rawContent, oldContent, mentions, author, authorId, channelName, isBot } = event.payload as any;
    console.log(`[DiscordReceptor] Message ${messageId} edited by ${author}`);

    const facetId = `discord-msg-${messageId}`;
    const speechFacetId = `speech-${messageId}`;

    if (state.facets.has(facetId)) {
      if (state.facets.has(speechFacetId)) {
        this.addOperation({ type: 'rewriteFacet', id: speechFacetId, changes: { content: `${author}: ${content}` } });
      }
      this.addOperation({
        type: 'rewriteFacet',
        id: facetId,
        changes: { state: { source: 'discord', eventType: 'discord-message', metadata: { channelName, author, authorId, isBot, rawContent, mentions } } }
      });
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `discord-edit-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author} edited their message`,
          state: { source: 'discord', eventType: 'discord-message-edited', metadata: { messageId, oldContent, newContent: content } }
        }
      });
    }
  }

  private handleMessageDelete(event: SpaceEvent, state: ReadonlyVEILState): void {
    const { messageId, author, channelName } = event.payload as any;
    console.log(`[DiscordReceptor] Message ${messageId} deleted`);

    const facetId = `discord-msg-${messageId}`;
    if (state.facets.has(facetId)) {
      this.addOperation({ type: 'removeFacet', id: facetId });
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `discord-delete-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author || 'Someone'} deleted their message`,
          state: { source: 'discord', eventType: 'discord-message-deleted', metadata: { messageId, deletedFacetId: facetId } }
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: Infrastructure Setup
  // ═══════════════════════════════════════════════════════════════════════════

  private checkInfrastructure(): void {
    if (this.infrastructureTriggered || !this.discordConfig || !this.space) return;

    const components = this.space.components || [];
    const mountedTypes = new Set(components.map((c: any) => c.constructor.name));

    if (![...this.requiredComponents].every(type => mountedTypes.has(type))) return;
    if (components.some((c: any) => c.constructor.name === 'DiscordAfferent')) {
      this.infrastructureTriggered = true;
      return;
    }

    console.log('[DiscordReceptor] All components ready - creating DiscordAfferent');
    this.infrastructureTriggered = true;

    // Emit system prompts
    if (this.agentSystemPrompts?.length) {
      for (const { agentName, systemPrompt } of this.agentSystemPrompts) {
        if (systemPrompt) {
          this.addOperation({
            type: 'addFacet',
            facet: { id: `system-prompt:${agentName}`, type: 'ambient', content: systemPrompt }
          });
        }
      }
    }

    // Create DiscordAfferent
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
          _axonMetadata: { moduleUrl: this.discordConfig.moduleUrl, manifestUrl: this.discordConfig.manifestUrl }
        }
      }
    });
  }
}

/**
 * DiscordEffector - Unified outbound Discord component
 *
 * Handles:
 * - Typing indicators on agent-activation
 * - Sending speech facets to Discord
 *
 * Constraints:
 * - Priority 300 (standard effector)
 * - Must run after DiscordReceptor (we read facets it creates)
 * - Must run after AgentComponent (we read speech facets the agent creates)
 */
class DiscordEffector extends Component {
  constraints = [
    priorityConstraint(ComponentPriority.EFFECTOR),
    afterComponentType('DiscordReceptor'),
    afterComponentType('AgentComponent')
  ];

  private discordAfferent?: any;

  execute(context: ExecutionContext): void {
    const { state, frame } = context;

    // Lazy lookup for DiscordAfferent
    if (!this.discordAfferent && this.space) {
      this.discordAfferent = this.space.components.find((c: any) => c.constructor.name === 'DiscordAfferent');
    }

    if (!frame?.deltas) return;

    for (const delta of frame.deltas) {
      if (delta.type !== 'addFacet') continue;
      const facet = delta.facet;

      // Typing indicator on activation
      if (facet.type === 'agent-activation') {
        this.handleActivation(facet, state);
      }

      // Send speech to Discord
      if (facet.type === 'speech') {
        this.handleSpeech(facet, state);
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

    if (!streamId?.startsWith('discord:')) return;

    console.log(`[DiscordEffector] Processing speech for stream: ${streamId}`);

    // Handle reply syntax
    const replyMatch = content.match(/^<reply:@([^>]+)>\s*/);
    let replyToMessageId = null;
    if (replyMatch) {
      content = content.substring(replyMatch[0].length);
      replyToMessageId = this.inferReplyTarget(replyMatch[1], speech, state);
    }

    // Find channel from latest message
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message'
    );
    if (discordMessages.length === 0) return;

    const latestMessage = discordMessages[discordMessages.length - 1] as any;
    const channelId = latestMessage.attributes?.channelId;
    if (!channelId || !this.discordAfferent) return;

    const sendParams: any = { channelId, message: content };
    if (replyToMessageId) sendParams.replyTo = replyToMessageId;

    console.log(`[DiscordEffector] Sending to channel ${channelId}: "${content}"`);

    if (typeof this.discordAfferent.send === 'function') {
      this.discordAfferent.send(sendParams).catch((err: any) => console.error(`Failed to send:`, err));
    } else if (this.discordAfferent.actions?.has('send')) {
      this.discordAfferent.actions.get('send')(sendParams).catch((err: any) => console.error(`Failed to send:`, err));
    }
  }

  private inferReplyTarget(username: string, speech: any, state: ReadonlyVEILState): string | null {
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message'
    ) as any[];

    // Check activation event
    const activations = Array.from(state.facets.values()).filter(
      f => f.type === 'agent-activation' && (f as any).state?.streamRef?.streamId === speech.streamId
    ) as any[];

    if (activations.length > 0) {
      const triggerMessageId = activations[activations.length - 1].state?.messageId;
      const triggerMessage = discordMessages.find(m => m.attributes?.messageId === triggerMessageId);
      if (triggerMessage?.state?.metadata?.author === username) {
        return triggerMessageId;
      }
    }

    // Find last message from username
    for (let i = discordMessages.length - 1; i >= 0; i--) {
      if (discordMessages[i].state?.metadata?.author === username) {
        return discordMessages[i].attributes.messageId;
      }
    }

    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Lua Scripting Support
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ToolCallHandler - Executes tool calls from Lua scripts
 *
 * Handles:
 * - Processing tool-call facets created by ScriptExecutorEffector
 * - Routing tool calls to appropriate handlers (Discord actions, etc.)
 * - Creating tool-call-result facets to resume blocked scripts
 *
 * Constraints:
 * - Priority 300 (effector)
 * - Must run after ScriptExecutorEffector (which creates tool-call facets)
 */
class ToolCallHandler extends Component {
  constraints = [
    priorityConstraint(ComponentPriority.EFFECTOR),
    afterComponentType('ScriptExecutorEffector')
  ];

  private discordAfferent?: any;

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame?.deltas) return;

    // Lazy lookup for DiscordAfferent
    if (!this.discordAfferent && this.space) {
      this.discordAfferent = this.space.components.find((c: any) => c.constructor.name === 'DiscordAfferent');
    }

    // Process tool-call facets from this frame
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && isToolCallFacet(delta.facet)) {
        this.handleToolCall(delta.facet, state);
      }
    }
  }

  private async handleToolCall(facet: any, state: ReadonlyVEILState): Promise<void> {
    const { id: toolCallId, parentScriptId, toolName, args } = facet;
    console.log(`[ToolCallHandler] Executing tool: ${toolName}(${JSON.stringify(args)})`);

    try {
      let result: unknown;

      // Route tool calls to appropriate handlers
      switch (toolName) {
        case 'discord_send':
          result = await this.handleDiscordSend(args, state);
          break;

        case 'discord_typing':
          result = await this.handleDiscordTyping(args, state);
          break;

        case 'discord_join':
          result = await this.handleDiscordJoin(args);
          break;

        case 'discord_leave':
          result = await this.handleDiscordLeave(args);
          break;

        case 'log':
          // Already handled by builtins, but support as tool too
          console.log('[Lua]', ...(args as any[]));
          result = true;
          break;

        default:
          // Unknown tool - return error
          this.addOperation({
            type: 'addFacet',
            facet: createToolCallResultFacet(
              `tool-result:${Date.now()}`,
              toolCallId,
              parentScriptId,
              { success: false, error: `Unknown tool: ${toolName}` }
            )
          });
          return;
      }

      // Create success result
      this.addOperation({
        type: 'addFacet',
        facet: createToolCallResultFacet(
          `tool-result:${Date.now()}`,
          toolCallId,
          parentScriptId,
          { success: true, result }
        )
      });

    } catch (error: any) {
      console.error(`[ToolCallHandler] Tool ${toolName} failed:`, error);
      this.addOperation({
        type: 'addFacet',
        facet: createToolCallResultFacet(
          `tool-result:${Date.now()}`,
          toolCallId,
          parentScriptId,
          { success: false, error: error.message || String(error) }
        )
      });
    }
  }

  private async handleDiscordSend(args: unknown[], state: ReadonlyVEILState): Promise<any> {
    if (!this.discordAfferent) {
      throw new Error('Discord not connected');
    }

    const [channelIdOrMessage, maybeMessage] = args;
    let channelId: string;
    let message: string;

    if (typeof maybeMessage === 'string') {
      // Called as discord_send(channelId, message)
      channelId = String(channelIdOrMessage);
      message = maybeMessage;
    } else if (typeof channelIdOrMessage === 'string') {
      // Called as discord_send(message) - use latest channel
      message = channelIdOrMessage;
      channelId = this.getLatestChannelId(state);
      if (!channelId) throw new Error('No channel context available');
    } else {
      throw new Error('Invalid arguments: expected (message) or (channelId, message)');
    }

    const sendFn = this.discordAfferent.send || this.discordAfferent.actions?.get('send');
    if (!sendFn) throw new Error('Discord send function not available');

    await sendFn({ channelId, message });
    return { sent: true, channelId };
  }

  private async handleDiscordTyping(args: unknown[], state: ReadonlyVEILState): Promise<any> {
    if (!this.discordAfferent?.sendTyping) {
      throw new Error('Discord not connected');
    }

    const [channelId] = args;
    const targetChannel = channelId ? String(channelId) : this.getLatestChannelId(state);
    if (!targetChannel) throw new Error('No channel context available');

    await this.discordAfferent.sendTyping({ channelId: targetChannel });
    return { typing: true, channelId: targetChannel };
  }

  private async handleDiscordJoin(args: unknown[]): Promise<any> {
    if (!this.discordAfferent) {
      throw new Error('Discord not connected');
    }

    const [channelId] = args;
    if (!channelId) throw new Error('Channel ID required');

    const joinFn = this.discordAfferent.join || this.discordAfferent.actions?.get('join');
    if (!joinFn) throw new Error('Discord join function not available');

    await joinFn({ channelId: String(channelId) });
    return { joined: true, channelId: String(channelId) };
  }

  private async handleDiscordLeave(args: unknown[]): Promise<any> {
    if (!this.discordAfferent) {
      throw new Error('Discord not connected');
    }

    const [channelId] = args;
    if (!channelId) throw new Error('Channel ID required');

    const leaveFn = this.discordAfferent.leave || this.discordAfferent.actions?.get('leave');
    if (!leaveFn) throw new Error('Discord leave function not available');

    await leaveFn({ channelId: String(channelId) });
    return { left: true, channelId: String(channelId) };
  }

  private getLatestChannelId(state: ReadonlyVEILState): string {
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message'
    );
    if (discordMessages.length === 0) return '';
    const latestMessage = discordMessages[discordMessages.length - 1] as any;
    return latestMessage.attributes?.channelId || '';
  }
}

/**
 * Create and configure a ToolRegistry with Discord tools
 */
function createDiscordToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();

  // Discord tools
  registry.register({
    name: 'discord_send',
    description: 'Send a message to a Discord channel',
    parameters: [
      { name: 'channelId', type: 'string', description: 'Channel ID (optional, uses current channel if omitted)', required: false },
      { name: 'message', type: 'string', description: 'Message to send', required: true }
    ]
  });

  registry.register({
    name: 'discord_typing',
    description: 'Show typing indicator in a Discord channel',
    parameters: [
      { name: 'channelId', type: 'string', description: 'Channel ID (optional)', required: false }
    ]
  });

  registry.register({
    name: 'discord_join',
    description: 'Join a Discord channel',
    parameters: [
      { name: 'channelId', type: 'string', description: 'Channel ID to join', required: true }
    ]
  });

  registry.register({
    name: 'discord_leave',
    description: 'Leave a Discord channel',
    parameters: [
      { name: 'channelId', type: 'string', description: 'Channel ID to leave', required: true }
    ]
  });

  return registry;
}

// ═══════════════════════════════════════════════════════════════════════════
// Application
// ═══════════════════════════════════════════════════════════════════════════

export class DiscordApplication implements ConnectomeApplication {
  constructor(private config: DiscordAppConfig) {}

  async createSpace(hostRegistry?: Map<string, any>, lifecycleId?: string, spaceId?: string): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry, lifecycleId, spaceId, {
      orderingStrategy: 'multi-constraint',
      multiConstraintOptions: { verbose: true }
    });
    return { space, veilState };
  }

  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🎮 Initializing Discord application...');

    this.getComponentRegistry();

    const botToken = (this.config as any).botToken || '';
    const modulePort = this.config.discord.modulePort || 8080;

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

    // Add DiscordReceptor (unified inbound + infrastructure)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordReceptor',
        componentId: 'discord:DiscordReceptor',
        config: {
          discordConfig,
          agentSystemPrompts: [{ agentName: this.config.agentName, systemPrompt: this.config.systemPrompt }]
        }
      }
    });

    // Add DiscordEffector (unified outbound)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordEffector',
        componentId: 'discord:DiscordEffector',
        config: {}
      }
    });

    // Add ActionEffector and ContextTransform
    space.emit({ topic: 'component:add', source: space.getRef(), timestamp: Date.now(), payload: { componentType: 'ActionEffector', componentId: 'discord:ActionEffector', config: {} } });
    space.emit({ topic: 'component:add', source: space.getRef(), timestamp: Date.now(), payload: { componentType: 'ContextTransform', componentId: 'discord:ContextTransform', config: {} } });

    // Create tool registry with Discord tools
    const toolRegistry = createDiscordToolRegistry();

    // Add ScriptExecutorEffector for Lua scripting support
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ScriptExecutorEffector',
        componentId: 'discord:ScriptExecutorEffector',
        config: { toolRegistry }
      }
    });

    // Add ToolCallHandler to execute tool calls from Lua scripts
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ToolCallHandler',
        componentId: 'discord:ToolCallHandler',
        config: {}
      }
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // Add AgentComponent
    if (!space.getComponentById('discord-agent:AgentComponent')) {
      space.emit({
        topic: 'component:add',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          componentType: 'AgentComponent',
          componentId: 'discord-agent:AgentComponent',
          config: { agentConfig: { name: this.config.agentName, systemPrompt: this.config.systemPrompt, autoActionRegistration: true } }
        }
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Load AXON modules
    const controlPanelLoader = new AxonLoaderComponent();
    space.addComponent(controlPanelLoader, 'axon-loader:discord-control-panel');
    await controlPanelLoader.connect(`axon://localhost:${modulePort}/modules/discord-control-panel/manifest`);

    const factoryLoader = new AxonLoaderComponent();
    space.addComponent(factoryLoader, 'axon-loader:component-factory');
    await factoryLoader.connect(`axon://localhost:${modulePort}/modules/component-factory/manifest`);

    console.log('✅ Discord application initialized');
  }

  getComponentRegistry(): typeof ComponentRegistry {
    const registry = ComponentRegistry;
    registry.register('AgentComponent', AgentComponent);
    registry.register('ComponentManager', ComponentManager);
    registry.register('DiscordReceptor', DiscordReceptor);
    registry.register('DiscordEffector', DiscordEffector);
    // Lua Scripting components
    registry.register('ScriptExecutorEffector', ScriptExecutorEffector);
    registry.register('ToolCallHandler', ToolCallHandler);
    return registry;
  }

  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Discord application started!');
  }

  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored');
  }
}
