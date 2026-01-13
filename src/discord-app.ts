/**
 * Discord Application for Connectome (Consolidated)
 *
 * FLEX Architecture with explicit multi-constraint ordering.
 *
 * Component structure:
 * - DiscordReceptor: All inbound Discord handling + infrastructure setup
 * - DiscordOutbound: All outbound Discord actions (after AgentComponent)
 */

import {
  // Host types
  ConnectomeHost,
  // Spaces
  Space,
  SpaceComponent as Component,
  ComponentManager,
  ActionRouter,
  // VEIL
  VEILStateManager,
  // Persistence
  ComponentRegistry,
  // Agent
  AgentComponent,
  ResponseHandler,
  // Components
  AxonLoaderComponent,
  // HUD
  ContextRenderer,
  // Widgets
  TextEditorControlPanel,
  ControlPanelActionsListener,
  PanelScopeReceptor,
  // Helpers
  updateStateFacets,
  // Constraints
  priorityConstraint,
  ComponentPriority,
  afterComponentType,
  beforeComponentType,
  // Scripting
  ScriptRunner,
  ActionResultProcessor,
  ActivationDecider,
  createToolRegistry,
  setGlobalToolRegistry,
  getGlobalToolRegistry,
  isToolCallFacet,
  createToolCallResultFacet,
  // Tool Mode Control
  ToolModeResolver,
  ToolModeHandler,
  setToolModeToolDefinition,
  resolveToolMode,
  ToolInvocationMode,
  // Types
  SpaceEvent,
} from 'connectome-ts';

import type { ConnectomeApplication } from 'connectome-ts';
import type { Facet, ReadonlyVEILState } from 'connectome-ts';
import type { ToolRegistry } from 'connectome-ts';
import type { ExecutionContext } from 'connectome-ts/dist/spaces/types';

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
 * - Must run before DiscordOutbound (we create facets it reads)
 * - Must run before AgentComponent (we create activations it processes)
 */
class DiscordReceptor extends Component {
  constraints = [
    priorityConstraint(ComponentPriority.RECEPTOR),
    beforeComponentType('DiscordOutbound'),
    beforeComponentType('AgentComponent')
  ];

  // Infrastructure state
  private discordConfig?: any;
  private agentSystemPrompts?: Array<{ agentName: string; systemPrompt: string }>;
  private infrastructureTriggered = false;
  private requiredComponents = new Set(['DiscordOutbound', 'ActionRouter', 'ContextRenderer']);

  execute(context: ExecutionContext): void {
    const { event, state } = context;

    // Step 1: Handle Discord events → create facets
    this.handleDiscordEvents(event, state);

    // Step 2: Infrastructure check (create DiscordAfferent when ready)
    this.checkInfrastructure();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Discord Event Handling (Inbound Logic)
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
  // Infrastructure Setup
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
 * DiscordOutbound - Unified outbound Discord component
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
class DiscordOutbound extends Component {
  constraints = [
    priorityConstraint(ComponentPriority.EFFECTOR),
    afterComponentType('DiscordReceptor'),
    afterComponentType('AgentComponent')
  ];

  // No topics filter - needs to run on all events to:
  // 1. Detect agent-activation facets in frame deltas (from discord:message events)
  // 2. Handle activation:stream events for typing throttle
  // 3. Handle activation:completed for cleanup
  // 4. Send speech facets to Discord (from activation:completed frames)

  private discordAfferent?: any;

  // Track typing state per activation for 8s throttle
  private typingState = new Map<string, { channelId: string; lastSent: number }>();
  private readonly TYPING_INTERVAL = 8000; // 8 seconds (Discord clears at 10s)

  execute(context: ExecutionContext): void {
    const { state, frame, event } = context;

    // Lazy lookup for DiscordAfferent
    if (!this.discordAfferent && this.space) {
      this.discordAfferent = this.space.components.find((c: any) => c.constructor.name === 'DiscordAfferent');
    }

    // Handle stream events for typing throttle
    if (event?.topic === 'activation:stream') {
      this.handleStreamTyping(event.payload);
      return;
    }

    // Clean up typing state on completion
    if (event?.topic === 'activation:completed') {
      const activationId = (event.payload as any)?.activationId;
      if (activationId) {
        this.typingState.delete(activationId);
      }
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

  /**
   * Handle streaming chunk - throttle typing indicator to every 8 seconds
   */
  private handleStreamTyping(payload: any): void {
    if (!payload || !this.discordAfferent?.sendTyping) return;

    const { activationId, done } = payload;
    if (!activationId) return;

    // Get or lookup channel from typing state (set during activation)
    const typingInfo = this.typingState.get(activationId);
    if (!typingInfo) return; // No channel context for this activation

    if (done) {
      // Stream complete - clean up (also done in activation:completed handler)
      this.typingState.delete(activationId);
      return;
    }

    // Check if we should send typing (throttle to TYPING_INTERVAL)
    const now = Date.now();
    if (now - typingInfo.lastSent >= this.TYPING_INTERVAL) {
      console.log(`[DiscordEffector] Refreshing typing indicator for activation ${activationId}`);
      this.discordAfferent.sendTyping({ channelId: typingInfo.channelId }).catch((err: any) =>
        console.error(`Failed to refresh typing indicator:`, err)
      );
      typingInfo.lastSent = now;
    }
  }

  private handleActivation(facet: Facet, state: ReadonlyVEILState): void {
    const activation = facet as any;
    const channelId = activation.state?.channelId || activation.state?.metadata?.channelId;
    if (!channelId || !this.discordAfferent?.sendTyping) return;

    console.log(`[DiscordOutbound] Sending typing indicator to channel: ${channelId}`);
    this.discordAfferent.sendTyping({ channelId }).catch((err: any) =>
      console.error(`Failed to send typing indicator:`, err)
    );

    // Initialize typing state for stream throttle
    const activationId = activation.id || facet.id;
    this.typingState.set(activationId, { channelId, lastSent: Date.now() });
  }

  private handleSpeech(facet: Facet, state: ReadonlyVEILState): void {
    const speech = facet as any;
    const streamId = speech.streamId;
    let content = speech.content;

    if (!streamId?.startsWith('discord:')) return;

    console.log(`[DiscordOutbound] Processing speech for stream: ${streamId}`);

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

    console.log(`[DiscordOutbound] Sending to channel ${channelId}: "${content}"`);

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
 * - Processing tool-call facets created by ScriptRunner
 * - Routing tool calls to appropriate handlers (Discord actions, etc.)
 * - Creating tool-call-result facets to resume blocked scripts
 *
 * Constraints:
 * - Priority 300 (effector)
 * - Must run after ScriptRunner (which creates tool-call facets)
 */
class ToolCallHandler extends Component {
  constraints = [
    priorityConstraint(ComponentPriority.EFFECTOR),
    afterComponentType('ScriptRunner')
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
          // Emit tool-call:completed event to trigger next frame
          this.emit({
            topic: 'tool-call:completed',
            timestamp: Date.now(),
            payload: { toolCallId, parentScriptId, success: false }
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

      // Emit tool-call:completed event to trigger next frame
      this.emit({
        topic: 'tool-call:completed',
        timestamp: Date.now(),
        payload: { toolCallId, parentScriptId, success: true }
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
      // Emit tool-call:completed event to trigger next frame
      this.emit({
        topic: 'tool-call:completed',
        timestamp: Date.now(),
        payload: { toolCallId, parentScriptId, success: false }
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
      // Called as discord_send(message) - use latest channel or first joined
      message = channelIdOrMessage;
      channelId = this.getLatestChannelId(state);
      if (!channelId) {
        // Fallback to first joined channel
        channelId = this.getFirstJoinedChannel(state);
      }
      if (!channelId) {
        throw new Error('No channel context available. Either reply to a Discord message, or specify a channel ID: discord_send(channelId, message)');
      }
    } else {
      throw new Error('Invalid arguments: expected (message) or (channelId, message)');
    }

    if (!this.discordAfferent.send) throw new Error('Discord send function not available');

    await this.discordAfferent.send({ channelId, message });
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
    if (!this.discordAfferent?.join) {
      throw new Error('Discord not connected');
    }

    const [channelId] = args;
    if (!channelId) throw new Error('Channel ID required');

    await this.discordAfferent.join({ channelId: String(channelId) });
    return { joined: true, channelId: String(channelId) };
  }

  private async handleDiscordLeave(args: unknown[]): Promise<any> {
    if (!this.discordAfferent?.leave) {
      throw new Error('Discord not connected');
    }

    const [channelId] = args;
    if (!channelId) throw new Error('Channel ID required');

    await this.discordAfferent.leave({ channelId: String(channelId) });
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

  private getFirstJoinedChannel(state: ReadonlyVEILState): string {
    // Look for component-state facet with joinedChannels
    for (const facet of state.facets.values()) {
      if (facet.type === 'component-state') {
        const componentState = (facet as any).state;
        if (componentState?.joinedChannels && Array.isArray(componentState.joinedChannels)) {
          return componentState.joinedChannels[0] || '';
        }
      }
    }
    return '';
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

  // Tool Mode Control - allows agent to switch between native and programmatic tool execution
  registry.register({
    name: 'setToolMode',
    description: 'Set the execution mode for a tool. Use "native" for immediate execution with feedback, or "programmatic" for batched execution in Lua scripts.',
    parameters: [
      { name: 'toolName', type: 'string', description: 'Name of the tool to configure, or "*" for all tools', required: true },
      { name: 'mode', type: 'string', description: 'Invocation mode: "native" (immediate, each call triggers re-activation) or "programmatic" (batched, only final result triggers re-activation)', required: true },
      { name: 'priority', type: 'number', description: 'Priority for this preference (higher wins in conflicts). Default: 75', required: false },
      { name: 'duration', type: 'number', description: 'Optional duration in milliseconds. If set, preference expires after this time.', required: false }
    ],
    defaultInvocationMode: 'native', // This tool should always be native
    allowModeOverride: false // Cannot change mode of setToolMode itself
  });

  return registry;
}

/**
 * LuaScriptingPromptEmitter - Emits Lua scripting documentation as ambient facet
 *
 * This component dynamically generates tool lists based on current mode preferences.
 * It subscribes to tool-mode:changed events to refresh the prompt when modes change.
 *
 * Constraints:
 * - Priority 0 (modulator - runs early to set up context)
 */
class LuaScriptingPromptEmitter extends Component {
  constraints = [priorityConstraint(0)];  // Modulator priority
  topics = ['tool-mode:changed'];  // Subscribe to mode change events

  private facetId = 'system-prompt:lua-scripting';
  private initialized = false;

  // Get tool registry from global (can't pass via config as methods are lost during serialization)
  private getToolRegistry(): ToolRegistry | undefined {
    return getGlobalToolRegistry();
  }

  execute(context: ExecutionContext): void {
    const { event, state } = context;

    // Initial emission on first execute
    if (!this.initialized) {
      this.initialized = true;
      this.emitToolPrompt(state);
      return;
    }

    // Refresh on tool-mode:changed event
    if (event?.topic === 'tool-mode:changed') {
      const payload = event.payload as { toolName?: string; mode?: string; setBy?: string } || {};
      const { toolName, mode, setBy } = payload;
      console.log(`[LuaScriptingPromptEmitter] Tool mode changed: ${toolName} → ${mode} (by ${setBy})`);
      if (toolName && mode) {
        this.emitToolPrompt(state, { toolName, mode });
      } else {
        this.emitToolPrompt(state);  // Refresh without specific change info
      }
    }
  }

  private emitToolPrompt(state: ReadonlyVEILState, modeChange?: { toolName: string; mode: string }): void {
    const toolRegistry = this.getToolRegistry();
    if (!toolRegistry) {
      console.warn('[LuaScriptingPromptEmitter] No tool registry available');
      return;
    }

    // Get all tools and resolve their current modes
    const tools = toolRegistry.getTools();
    const toolsWithModes = tools.map(tool => {
      const resolution = resolveToolMode(tool.name, state, toolRegistry);
      return {
        ...tool,
        currentMode: resolution.mode,
        modeSource: resolution.source
      };
    });

    // Split tools by mode
    const nativeTools = toolsWithModes.filter(t => t.currentMode === 'native');
    const programmaticTools = toolsWithModes.filter(t => t.currentMode === 'programmatic');

    // Generate the prompt
    const promptContent = generateLuaScriptingPromptWithModes(nativeTools, programmaticTools);

    // Check if facet already exists
    const existingFacet = state.facets.get(this.facetId);

    if (existingFacet) {
      // Update existing facet
      console.log('[LuaScriptingPromptEmitter] Updating tool prompt (mode change)');
      this.addOperation({
        type: 'rewriteFacet',
        id: this.facetId,
        changes: { content: promptContent }
      });
    } else {
      // Create new facet
      console.log('[LuaScriptingPromptEmitter] Emitting initial tool prompt');
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: this.facetId,
          type: 'ambient',
          content: promptContent
        }
      });
    }

    // If this was triggered by a mode change, also emit a notification
    if (modeChange) {
      const modeLabel = modeChange.mode === 'programmatic' ? 'Lua scripting only' : 'native calls';
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `tool-mode-notification:${Date.now()}`,
          type: 'ambient',
          ephemeral: true,
          content: `[Tool mode changed: "${modeChange.toolName}" is now available for ${modeLabel}]`
        }
      });
    }
  }
}

/**
 * Tool with resolved mode information
 */
interface ToolWithMode {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; required?: boolean; description?: string }>;
  currentMode: ToolInvocationMode;
  modeSource: string;
}

/**
 * Format a tool for display in the prompt
 */
function formatToolDoc(tool: ToolWithMode): string {
  const params = tool.parameters.map(p => {
    const req = p.required !== false ? '' : '?';
    return `${p.name}${req}: ${p.type}`;
  }).join(', ');
  return `  ${tool.name}(${params}) - ${tool.description}`;
}

/**
 * Generate system prompt with tools split by mode
 */
function generateLuaScriptingPromptWithModes(
  nativeTools: ToolWithMode[],
  programmaticTools: ToolWithMode[]
): string {
  const nativeToolDocs = nativeTools.map(formatToolDoc).join('\n');
  const programmaticToolDocs = programmaticTools.map(formatToolDoc).join('\n');

  let toolsSection = '';

  // Native tools section (available for both direct calls and Lua)
  if (nativeTools.length > 0) {
    toolsSection += `**Native Tools** (available for direct <action> calls AND Lua scripts):
${nativeToolDocs}

`;
  }

  // Programmatic tools section (Lua only)
  if (programmaticTools.length > 0) {
    toolsSection += `**Scripting-Only Tools** (available ONLY inside Lua scripts):
${programmaticToolDocs}

`;
  }

  return `## Lua Scripting

You have access to a Lua scripting action that allows you to chain multiple operations in a single response.
This is useful when you need to perform several related actions without waiting for intermediate responses.

### Usage

Use the "lua" action with Lua code in the content. Use \`return\` to get results back.
Note: Use the \`cnctm:\` namespace prefix for action tags (similar to Anthropic's \`antml:\` prefix):

<cnctm:action name="lua">
local result = discord_send("Hello!")
return result
</cnctm:action>

### Available Functions

**Built-in:**
  print(...) - Print to console for debugging
  json.encode(value) - Convert value to JSON string
  json.decode(str) - Parse JSON string to value

${toolsSection.trim()}

### Examples

Send a message to the current channel:
<cnctm:action name="lua">
local result = discord_send("Hello from Lua!")
return result
</cnctm:action>

Send to a specific channel:
<cnctm:action name="lua">
local result = discord_send("1234567890", "Hello to specific channel!")
return result
</cnctm:action>

Chain multiple actions:
<cnctm:action name="lua">
discord_typing()
local msg1 = discord_send("First message")
local msg2 = discord_send("Second message")
return { first = msg1, second = msg2 }
</cnctm:action>

Conditional logic:
<cnctm:action name="lua">
local result = discord_send("Testing...")
if result and result.sent then
  return discord_send("It worked!")
else
  return { error = "Failed to send" }
end
</cnctm:action>

### Notes
- Tool calls use positional arguments, not tables (e.g., \`discord_send("message")\` not \`discord_send({ message = "..." })\`)
- Tool calls block until complete, then return their result
- Use \`return\` to pass results back from the script
- Errors in scripts will be reported back to you
- When replying to a Discord message, \`discord_send("message")\` uses that channel automatically
- If no channel context exists (e.g., activated via control panel), you must specify: \`discord_send(channelId, "message")\`
- Use \`setToolMode(toolName, mode)\` to switch tools between "native" and "programmatic" modes`;
}

/**
 * Generate static system prompt (for initial load, before any mode changes)
 * This is used for agentSystemPrompts which are set at startup.
 */
function generateLuaScriptingPrompt(registry: ToolRegistry): string {
  // At startup, all tools are in their default mode (native)
  const tools = registry.getTools();
  const allToolsAsNative: ToolWithMode[] = tools.map(tool => ({
    ...tool,
    currentMode: tool.defaultInvocationMode || 'native' as ToolInvocationMode,
    modeSource: 'tool-default'
  }));
  
  // Split by default mode
  const nativeTools = allToolsAsNative.filter(t => t.currentMode === 'native');
  const programmaticTools = allToolsAsNative.filter(t => t.currentMode === 'programmatic');
  
  return generateLuaScriptingPromptWithModes(nativeTools, programmaticTools);
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

    // Create tool registry early so we can generate Lua scripting docs
    // Use global registry so ScriptRunner can access it
    const toolRegistry = createDiscordToolRegistry();
    setGlobalToolRegistry(toolRegistry);
    const luaScriptingPrompt = generateLuaScriptingPrompt(toolRegistry);

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
    // Include Lua scripting docs as a system prompt
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordReceptor',
        componentId: 'discord:DiscordReceptor',
        config: {
          discordConfig,
          agentSystemPrompts: [
            { agentName: this.config.agentName, systemPrompt: this.config.systemPrompt },
            { agentName: 'lua-scripting', systemPrompt: luaScriptingPrompt }
          ]
        }
      }
    });

    // Add DiscordOutbound (unified outbound)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordOutbound',
        componentId: 'discord:DiscordOutbound',
        config: {}
      }
    });

    // Add ActionRouter and ContextRenderer
    space.emit({ topic: 'component:add', source: space.getRef(), timestamp: Date.now(), payload: { componentType: 'ActionRouter', componentId: 'discord:ActionRouter', config: {} } });
    space.emit({ topic: 'component:add', source: space.getRef(), timestamp: Date.now(), payload: { componentType: 'ContextRenderer', componentId: 'discord:ContextRenderer', config: {} } });

    // Add ScriptRunner for Lua scripting support (uses global registry)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ScriptRunner',
        componentId: 'discord:ScriptRunner',
        config: {}
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

    // Add Tool Mode Control components
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ToolModeResolver',
        componentId: 'discord:ToolModeResolver',
        config: {}
      }
    });

    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ToolModeHandler',
        componentId: 'discord:ToolModeHandler',
        config: {}
      }
    });

    // Add ActionResultProcessor to emit activation:create events from action-results
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ActionResultProcessor',
        componentId: 'discord:ActionResultProcessor',
        config: {}
      }
    });

    // Add ActivationDecider to handle semantic events and create agent-activation facets
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ActivationDecider',
        componentId: 'discord:ActivationDecider',
        config: {}
      }
    });

    // Add ResponseHandler to accumulate streaming chunks and emit activation:completed
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ResponseHandler',
        componentId: 'discord:ResponseHandler',
        config: {}
      }
    });

    // Add LuaScriptingPromptEmitter for dynamic tool mode updates
    // This component regenerates the tool list when modes change
    // It uses the global tool registry (can't pass via config as methods are lost)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'LuaScriptingPromptEmitter',
        componentId: 'discord:LuaScriptingPromptEmitter',
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

    // Add Control Panel infrastructure receptors
    // These handle panel:tools-registered and panel:scope-change events
    // to create action-definition facets and manage tool visibility
    space.addComponent(new ControlPanelActionsListener(), 'infrastructure:ControlPanelActionsListener');
    space.addComponent(new PanelScopeReceptor(), 'infrastructure:PanelScopeReceptor');
    console.log('🎛️ Control Panel infrastructure added');

    // Add Text Editor Control Panel (built-in widget)
    // Provides file viewing/editing capabilities matching Anthropic's text editor tool
    const textEditorPanel = new TextEditorControlPanel({
      workingDirectory: process.cwd(),
      maxViewCharacters: 50000,
      maxBackupsPerFile: 5
    });
    space.addComponent(textEditorPanel, 'text-editor:TextEditorControlPanel');
    console.log('📝 Text Editor Control Panel added');

    console.log('✅ Discord application initialized');
  }

  getComponentRegistry(): typeof ComponentRegistry {
    const registry = ComponentRegistry;
    registry.register('AgentComponent', AgentComponent);
    registry.register('ResponseHandler', ResponseHandler);
    registry.register('ComponentManager', ComponentManager);
    registry.register('DiscordReceptor', DiscordReceptor);
    registry.register('DiscordOutbound', DiscordOutbound);
    registry.register('ActionRouter', ActionRouter);
    registry.register('ContextRenderer', ContextRenderer);
    // Lua Scripting components (FLEX architecture)
    registry.register('ScriptRunner', ScriptRunner);
    registry.register('ToolCallHandler', ToolCallHandler);
    registry.register('ActionResultProcessor', ActionResultProcessor);
    // Tool Mode Control components
    registry.register('ToolModeResolver', ToolModeResolver);
    registry.register('ToolModeHandler', ToolModeHandler);
    registry.register('ActivationDecider', ActivationDecider);
    registry.register('ResponseHandler', ResponseHandler);
    registry.register('LuaScriptingPromptEmitter', LuaScriptingPromptEmitter);
    // Built-in widgets
    registry.register('TextEditorControlPanel', TextEditorControlPanel);
    return registry;
  }

  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Discord application started!');
  }

  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored');

    // Re-setup global tool registry after restoration
    // This is needed because the global registry is cleared on process restart
    const toolRegistry = createDiscordToolRegistry();
    setGlobalToolRegistry(toolRegistry);
    console.log('🔧 Tool registry re-initialized with', toolRegistry.getTools().length, 'tools');
  }
}
