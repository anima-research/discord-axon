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
 * Receptor: Converts discord:connected events to facets
 */
class DiscordConnectedReceptor extends BaseReceptor {
  topics = ['discord:connected'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): any[] {
    console.log('[DiscordConnectedReceptor] Processing discord:connected event');
    return [{
      type: 'addFacet',
      facet: {
        id: `discord-connected-${Date.now()}`,
        type: 'event',
        content: 'Discord connected',
        state: {
          source: 'discord',
          eventType: 'discord-connected'
        },
        attributes: event.payload as Record<string, any>
      }
    }];
  }
}

/**
 * Receptor: Converts discord:message events into message facets and agent activations
 * Also tracks lastRead per channel in VEIL for de-duplication
 */
class DiscordMessageReceptor extends BaseReceptor {
  topics = ['discord:message'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): any[] {
    const payload = event.payload as any;
    const { channelId, channelName, author, authorId, content, rawContent, mentions, reply, messageId, streamId, streamType, isHistory, isBot } = payload;
    
    // Check if we've already processed this message (de-dup against VEIL)
    const lastReadFacet = state.facets.get(`discord-lastread-${channelId}`);
    const lastMessageId = lastReadFacet?.state?.value;
    
    if (lastMessageId && this.isOlderOrEqual(messageId, lastMessageId)) {
      console.log(`[DiscordMessageReceptor] Skipping old/duplicate message ${messageId}`);
      return []; // Skip old message
    }
    
    console.log(`[DiscordMessageReceptor] Processing message from ${author}: "${content}"${isHistory ? ' (history)' : ''}${reply ? ' (reply)' : ''}`);
    
    const deltas: any[] = [];
    
    // Format content with reply syntax if this is a reply
    let formattedContent = content;
    let replyToUsername = null;
    
    if (reply) {
      // Find the referenced message in VEIL to get the author
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
    
    // Create message facet (eventType must be in state for proper serialization!)
    deltas.push({
      type: 'addFacet',
      facet: {
        id: `discord-msg-${messageId}`,
        type: 'event',
        content: `${author}: ${formattedContent}`, // Include reply context in content
        state: {
          source: 'discord',
          eventType: 'discord-message',
          metadata: { 
            channelName, 
            author,
            authorId,
            isBot,
            isHistory,
            rawContent, // Original content with Discord IDs
            mentions, // Structured mention metadata
            reply // Reply information if this is a reply
          }
        },
        streamId,
        streamType,
        attributes: {
          channelId,
          messageId,
          mentions, // Also include in attributes for easy access
          reply // Reply information for quick access
        }
      }
    });
    
    // Update lastRead in VEIL (nested facet pattern)
    deltas.push(...updateStateFacets(
      'discord-lastread',
      { [channelId]: messageId },
      state
    ));
    
    // Only activate agent for live messages, not history
    if (!isHistory) {
      console.log(`[DiscordMessageReceptor] Creating agent activation`);
      deltas.push({
        type: 'addFacet',
        facet: {
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
        }
      });
    }
    
    return deltas;
  }
  
  private isOlderOrEqual(messageId: string, lastMessageId: string): boolean {
    // Discord snowflake IDs are chronological
    try {
      return BigInt(messageId) <= BigInt(lastMessageId);
    } catch {
      return false;
    }
  }
}

/**
 * Receptor: Detects offline edits and deletes by comparing history to VEIL
 */
class DiscordHistorySyncReceptor extends BaseReceptor {
  topics = ['discord:history-sync'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): any[] {
    const { channelId, messages } = event.payload as any;
    const deltas: any[] = [];
    
    console.log(`[DiscordHistorySync] Syncing ${messages.length} messages for channel ${channelId}`);
    
    // Build map of current Discord state
    const discordMessages = new Map(messages.map((m: any) => [m.messageId, m]));
    
    // Find all Discord message facets for this channel in VEIL
    console.log(`[DiscordHistorySync] Total facets in VEIL: ${state.facets.size}`);
    const eventFacets = Array.from(state.facets.values()).filter(f => f.type === 'event');
    console.log(`[DiscordHistorySync] Event facets: ${eventFacets.length}`);
    const eventTypes = new Set(eventFacets.map(f => (f as any).state?.eventType).filter(Boolean));
    console.log(`[DiscordHistorySync] Event types found: ${Array.from(eventTypes).join(', ')}`);
    
    const veilMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && 
           (f as any).state?.eventType === 'discord-message' &&  // eventType is in state!
           (f as any).attributes?.channelId === channelId
    );
    
    let deletedCount = 0;
    let editedCount = 0;
    
    console.log(`[DiscordHistorySync] Found ${veilMessages.length} discord-message facets for this channel`);
    
    for (const veilMsg of veilMessages) {
      const messageId = (veilMsg as any).attributes.messageId;
      const veilContent = (veilMsg as any).content;
      const discordMsg = discordMessages.get(messageId) as any;
      
      if (!discordMsg) {
        // Message was DELETED offline
        console.log(`[DiscordHistorySync] Message ${messageId} deleted offline`);
        deletedCount++;
        
        // Remove the message facet (exotemporal - rewriting reality)
        deltas.push({
          type: 'removeFacet',
          id: veilMsg.id
        });
        
        // Optional: Add event facet recording the deletion
        deltas.push({
          type: 'addFacet',
          facet: {
            id: `discord-offline-delete-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was deleted while offline]`,
            state: {
              source: 'discord-history-sync',
              eventType: 'discord-message-deleted-offline',
              metadata: { 
                messageId, 
                channelId 
              }
            },
            attributes: { 
              messageId, 
              channelId 
            },
            ephemeral: true
          }
        });
        
      } else if (this.extractContent(veilContent) !== discordMsg.content) {
        // Message was EDITED offline
        console.log(`[DiscordHistorySync] Message ${messageId} edited offline`);
        console.log(`  VEIL: "${this.extractContent(veilContent)}"`);
        console.log(`  Discord: "${discordMsg.content}"`);
        editedCount++;
        
        // Rewrite the message facet (exotemporal - updating to current reality)
        deltas.push({
          type: 'rewriteFacet',
          id: veilMsg.id,
          changes: {
            content: `${discordMsg.author}: ${discordMsg.content}`, // Parsed content
            state: {
              source: 'discord',
              eventType: 'discord-message',
              metadata: {
                ...((veilMsg as any).state?.metadata || {}),
                rawContent: discordMsg.rawContent, // Update raw content
                mentions: discordMsg.mentions // Update mention metadata
              }
            },
            attributes: {
              ...((veilMsg as any).attributes || {}),
              mentions: discordMsg.mentions // Update mention metadata in attributes
            }
          }
        });
        
        // Optional: Add event facet recording the edit
        deltas.push({
          type: 'addFacet',
          facet: {
            id: `discord-offline-edit-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was edited while offline]`,
            state: {
              source: 'discord-history-sync',
              eventType: 'discord-message-edited-offline',
              metadata: { 
                messageId, 
                channelId,
                oldContent: this.extractContent(veilContent),
                newContent: discordMsg.content,
                rawOldContent: (veilMsg as any).state?.metadata?.rawContent,
                rawNewContent: discordMsg.rawContent,
                mentions: discordMsg.mentions
              }
            },
            attributes: { 
              messageId, 
              channelId,
              oldContent: this.extractContent(veilContent),
              newContent: discordMsg.content,
              mentions: discordMsg.mentions
            }
          }
        });
      }
    }
    
    if (deletedCount > 0 || editedCount > 0) {
      console.log(`[DiscordHistorySync] Detected ${editedCount} edits, ${deletedCount} deletions while offline`);
    }
    
    return deltas;
  }
  
  private extractContent(fullContent: string): string {
    // Extract message content from "Author: content" format
    const match = fullContent.match(/^[^:]+: (.+)$/);
    return match ? match[1] : fullContent;
  }
}

/**
 * Receptor: Handles message edits
 */
class DiscordMessageUpdateReceptor extends BaseReceptor {
  topics = ['discord:messageUpdate'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): any[] {
    const payload = event.payload as any;
    const { messageId, content, rawContent, oldContent, rawOldContent, mentions, author, authorId, channelName, isBot } = payload;
    
    console.log(`[DiscordMessageUpdateReceptor] Message ${messageId} edited by ${author}`);
    
    const deltas: any[] = [];
    const facetId = `discord-msg-${messageId}`;
    
    // Check if the message facet exists
    if (state.facets.has(facetId)) {
      // Rewrite the message facet with new content (exotemporal - updating to reality)
      deltas.push({
        type: 'rewriteFacet',
        id: facetId,
        changes: {
          content: `${author}: ${content}`, // Use parsed content
          state: {
            source: 'discord',
            eventType: 'discord-message',
            metadata: {
              channelName,
              author,
              authorId,
              isBot,
              rawContent, // Updated raw content
              mentions // Updated mention metadata
            }
          },
          attributes: {
            mentions // Updated mention metadata in attributes
          }
        }
      });
      
      // Create an event facet for the edit
      deltas.push({
        type: 'addFacet',
        facet: {
          id: `discord-edit-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author} edited their message in #${channelName}`,
          state: {
            source: 'discord',
            eventType: 'discord-message-edited',
            metadata: {
              messageId,
              author,
              authorId,
              channelName,
              oldContent, // Parsed old content
              newContent: content, // Parsed new content
              rawOldContent, // Original old content
              rawNewContent: rawContent, // Original new content
              mentions // New mention metadata
            }
          },
          attributes: {
            messageId,
            oldContent,
            newContent: content,
            author,
            mentions
          }
        }
      });
    }
    
    return deltas;
  }
}

/**
 * Receptor: Handles message deletions
 */
class DiscordMessageDeleteReceptor extends BaseReceptor {
  topics = ['discord:messageDelete'];
  
  transform(event: SpaceEvent, state: ReadonlyVEILState): any[] {
    const payload = event.payload as any;
    const { messageId, author, channelName } = payload;
    
    console.log(`[DiscordMessageDeleteReceptor] Message ${messageId} deleted`);
    
    const deltas: any[] = [];
    const facetId = `discord-msg-${messageId}`;
    
    // Check if the message facet exists
    if (state.facets.has(facetId)) {
      // Remove the message facet (exotemporal - updating to reality)
      deltas.push({
        type: 'removeFacet',
        id: facetId
      });
      
      // Create an event facet for the deletion
      deltas.push({
        type: 'addFacet',
        facet: {
          id: `discord-delete-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author || 'Someone'} deleted their message in #${channelName || 'a channel'}`,
          state: {
            source: 'discord',
            eventType: 'discord-message-deleted',
            metadata: {
              messageId,
              author,
              channelName,
              deletedFacetId: facetId
            }
          },
          attributes: {
            messageId,
            author,
            deletedFacetId: facetId
          }
        }
      });
    }
    
    return deltas;
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
      (c.facet as any).state?.eventType === 'discord-connected'
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
      let content = speech.content;
      
      // Check if this is for Discord
      if (!streamId || !streamId.startsWith('discord:')) continue;
      
      console.log(`[DiscordSpeechEffector] Processing speech for stream: ${streamId}`);
      
      // Check for reply syntax: <reply:@username> message
      const replyMatch = content.match(/^<reply:@([^>]+)>\s*/);
      let replyToUsername = null;
      let replyToMessageId = null;
      
      if (replyMatch) {
        replyToUsername = replyMatch[1];
        content = content.substring(replyMatch[0].length); // Strip reply syntax
        console.log(`[DiscordSpeechEffector] Detected reply to @${replyToUsername}`);
        
        // Infer which message to reply to using heuristics
        replyToMessageId = this.inferReplyTarget(replyToUsername, speech, state);
      }
      
      // Find the channel ID
      const discordMessages = Array.from(state.facets.values()).filter(
        f => f.type === 'event' && f.state.eventType === 'discord-message'
      );
      
      if (discordMessages.length === 0) {
        console.warn('[DiscordSpeechEffector] No discord-message facets found');
        continue;
      }
      
      const latestMessage = discordMessages[discordMessages.length - 1] as any;
      const channelId = latestMessage.attributes?.channelId;
      
      if (!channelId) {
        console.warn('[DiscordSpeechEffector] No channelId in message facet');
        continue;
      }
      
      // Send message (as reply if we have a target)
      const sendParams: any = { channelId, message: content };
      if (replyToMessageId) {
        sendParams.replyTo = replyToMessageId;
        console.log(`[DiscordSpeechEffector] Sending as reply to message ${replyToMessageId}`);
      }
      
      console.log(`[DiscordSpeechEffector] Sending to channel ${channelId}: "${content}"`);
      
      // Call send on the Discord afferent
      const components = this.discordElement.components as any[];
      for (const comp of components) {
        if (comp.send && typeof comp.send === 'function') {
          try {
            await comp.send(sendParams);
            console.log(`[DiscordSpeechEffector] Successfully sent message`);
          } catch (error) {
            console.error(`Failed to send to Discord:`, error);
          }
          break;
        } else if (comp.actions && comp.actions.has('send')) {
          try {
            const handler = comp.actions.get('send');
            await handler(sendParams);
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
  
  /**
   * Infer which message to reply to using heuristics
   */
  private inferReplyTarget(username: string, speech: any, state: ReadonlyVEILState): string | null {
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && f.state?.eventType === 'discord-message'
    ) as any[];
    
    // Heuristic 1: Check the activation event - what message triggered this response?
    // The speech facet might have been created in response to an activation
    // We can find the activation by looking for recent activations in the same stream
    const activations = Array.from(state.facets.values()).filter(
      f => f.type === 'agent-activation' && 
      f.state?.streamRef?.streamId === speech.streamId
    ) as any[];
    
    if (activations.length > 0) {
      const latestActivation = activations[activations.length - 1];
      const triggerMessageId = latestActivation.state?.messageId;
      if (triggerMessageId) {
        const triggerMessage = discordMessages.find(m => m.attributes?.messageId === triggerMessageId);
        if (triggerMessage && triggerMessage.state?.metadata?.author === username) {
          console.log(`[DiscordSpeechEffector] Reply target (activation): ${triggerMessageId}`);
          return triggerMessageId;
        }
      }
    }
    
    // Heuristic 2: Find last message from username that mentioned the bot or replied to it
    const botUserId = '1382891708513128485'; // TODO: Make this configurable
    for (let i = discordMessages.length - 1; i >= 0; i--) {
      const msg = discordMessages[i];
      if (msg.state?.metadata?.author !== username) continue;
      
      // Check if it mentioned the bot
      const mentions = msg.state?.metadata?.mentions;
      if (mentions?.users?.some((u: any) => u.id === botUserId)) {
        console.log(`[DiscordSpeechEffector] Reply target (mentioned bot): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }
      
      // Check if it was a reply to the bot
      const reply = msg.state?.metadata?.reply;
      if (reply?.authorId === botUserId) {
        console.log(`[DiscordSpeechEffector] Reply target (replied to bot): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }
    }
    
    // Heuristic 3: Find last message from username (any)
    for (let i = discordMessages.length - 1; i >= 0; i--) {
      const msg = discordMessages[i];
      if (msg.state?.metadata?.author === username) {
        console.log(`[DiscordSpeechEffector] Reply target (last from user): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }
    }
    
    // Fallback: No message found - will send as mention instead of reply
    console.log(`[DiscordSpeechEffector] No reply target found for @${username}, will send as mention`);
    return null;
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
        // TODO: Token should come from Host's external system, but for now pass directly
        const botToken = (this.config as any).botToken || '';
        const modulePort = this.config.discord.modulePort || 8080;
        const axonUrl = `axon://localhost:${modulePort}/modules/discord-afferent/manifest?` + 
          `host=${encodeURIComponent(this.config.discord.host)}&` +
          `path=${encodeURIComponent('/ws')}&` +
          `guild=${encodeURIComponent(this.config.discord.guild)}&` +
          `agent=${encodeURIComponent(this.config.agentName)}&` +
          `token=${encodeURIComponent(botToken)}`;
        
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
      // TODO: Token should come from Host's external system, but for now pass directly
      const botToken = (this.config as any).botToken || '';
      const modulePort = this.config.discord.modulePort || 8080;
      const axonUrl = `axon://localhost:${modulePort}/modules/discord-afferent/manifest?` + 
        `host=${encodeURIComponent(this.config.discord.host)}&` +
        `path=${encodeURIComponent('/ws')}&` +
        `guild=${encodeURIComponent(this.config.discord.guild)}&` +
        `agent=${encodeURIComponent(this.config.agentName)}&` +
        `token=${encodeURIComponent(botToken)}`;
      
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
    
    // Note: RETM components (receptors/effectors) are registered in onStart()
    // so they're available both on fresh start and restore
    
    if (this.config.discord.autoJoinChannels && this.config.discord.autoJoinChannels.length > 0 && discordElem) {
      console.log('➕ Mounting auto-join effector for channels:', this.config.discord.autoJoinChannels);
      const autoJoinEffector = new DiscordAutoJoinEffector(
        this.config.discord.autoJoinChannels,
        discordElem
      );
      // Just mount - auto-registration handles the rest!
      await space.addComponentAsync(autoJoinEffector);
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
    
    // Mount Discord RETM components (auto-registration handles the rest!)
    console.log('➕ Mounting Discord Receptors and Effectors');
    const discordElem = space.children.find(c => c.name === 'discord');
    
    // Just mount - auto-registration happens automatically
    await space.addComponentAsync(new DiscordConnectedReceptor());
    await space.addComponentAsync(new DiscordMessageReceptor());
    await space.addComponentAsync(new DiscordHistorySyncReceptor());
    await space.addComponentAsync(new DiscordMessageUpdateReceptor());
    await space.addComponentAsync(new DiscordMessageDeleteReceptor());
    
    if (discordElem) {
      await space.addComponentAsync(new DiscordSpeechEffector(discordElem));
    }
    
    // Mount RETM components for agent processing
    const agentElem = space.children.find(child => child.name === 'discord-agent');
    if (agentElem) {
      const agentComponent = agentElem.getComponents(AgentComponent)[0];
      if (agentComponent && (agentComponent as any).agent) {
        const agent = (agentComponent as any).agent as AgentInterface;
        
        console.log('➕ Mounting AgentEffector and ContextTransform');
        await space.addComponentAsync(new AgentEffector(agentElem, agent));
        await space.addComponentAsync(new ContextTransform(veilState));
      }
    }
    
    // No initial activation - wait for Discord messages to trigger the agent
  }
  
  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored from snapshot');
    
    // Reconnect Discord afferent
    const discordElem = space.children.find(c => c.name === 'discord');
    if (discordElem) {
      const axonLoader = discordElem.getComponents(AxonLoaderComponent)[0];
      
      if (axonLoader && (axonLoader as any).axonUrl) {
        console.log('🔄 Reconnecting Discord afferent after restoration...');
        try {
          // Reload the component
          await axonLoader.connect((axonLoader as any).axonUrl);
          
          // Get the loaded afferent and start it
          const afferent = (axonLoader as any).loadedComponent;
          if (afferent && typeof afferent.start === 'function') {
            console.log('▶️ Starting Discord afferent...');
            await afferent.start();
            
            // Wait for connection and authentication
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Rejoin channels after reconnection
            if (this.config.discord.autoJoinChannels) {
              for (const channelId of this.config.discord.autoJoinChannels) {
                console.log(`📢 Rejoining channel: ${channelId}`);
                if (afferent.join && typeof afferent.join === 'function') {
                  await afferent.join({ channelId, scrollback: 50 });
                }
              }
            }
          }
        } catch (e) {
          console.log('⚠️ Failed to reconnect Discord afferent:', e);
        }
      }
    }
    
    // No activation needed - Discord messages will trigger the agent
  }
}
