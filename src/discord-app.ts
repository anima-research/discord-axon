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
import { Element } from 'connectome-ts/src/spaces/element';
import { Component } from 'connectome-ts/src/spaces/component';
import { SpaceEvent } from 'connectome-ts/src/spaces/types';
import { BaseReceptor, BaseEffector, BaseTransform } from 'connectome-ts/src/components/base-martem';
import { AgentEffector } from 'connectome-ts/src/agent/agent-effector';
import { ActionEffector } from 'connectome-ts/src/spaces/action-effector';
import { ContextTransform } from 'connectome-ts/src/hud/context-transform';
import { ElementRequestReceptor, ElementTreeMaintainer, ElementTreeTransform } from 'connectome-ts/src/spaces/element-tree-receptors';
import type { Facet, ReadonlyVEILState, FacetDelta, EffectorResult, AgentInterface, VEILDelta } from 'connectome-ts/src';
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
    const payload = event.payload as any;

    const deltas: any[] = [];

    // Store bot user ID in a persistent config facet for easy access
    if (payload.botUserId) {
      console.log(`[DiscordConnectedReceptor] Storing bot user ID: ${payload.botUserId}`);
      deltas.push(...updateStateFacets(
        'discord-config',
        { botUserId: payload.botUserId },
        state
      ));
    }

    // Also create the connection event facet
    deltas.push({
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

    return deltas;
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
    const { channelId, channelName, author, authorId, content, rawContent, mentions, reply, messageId, streamId, streamType, isBot } = payload;
    // Note: isHistory removed - history messages come through discord:history-sync, not discord:message
    
    // Check if we've already processed this message (de-dup against VEIL)
    const lastReadFacet = state.facets.get(`discord-lastread-${channelId}`);
    const lastMessageId = lastReadFacet?.state?.value;
    
    if (lastMessageId && this.isOlderOrEqual(messageId, lastMessageId)) {
      console.log(`[DiscordMessageReceptor] Skipping old/duplicate message ${messageId}`);
      return []; // Skip old message
    }
    
    console.log(`[DiscordMessageReceptor] Processing message from ${author}: "${content}"${reply ? ' (reply)' : ''}`);
    
    const deltas: any[] = [];

    // Retrieve bot user ID from VEIL state (set by DiscordConnectedReceptor)
    const botConfigFacet = state.facets.get('discord-config-botUserId');
    const botUserId = botConfigFacet?.state?.value;

    if (!botUserId) {
      console.warn('[DiscordMessageReceptor] Bot user ID not found in VEIL state, skipping activation checks');
    }
    
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
    
    // Create speech facet as nested child
    const speechFacet: any = {
      id: `speech-${messageId}`,
      type: 'speech',
      content: formattedContent,
      streamId,
      streamType,
      state: {
        speakerId: `discord:${authorId}`,
        speaker: author
      }
    };
    
    // If this is from the bot itself, mark it as agent-generated
    if (authorId === botUserId) {
      speechFacet.agentId = 'connectome'; // TODO: Make configurable
      speechFacet.agentName = 'Connectome';
    }
    
    // Create message facet (eventType must be in state for proper serialization!)
    // Message is the platform-specific container, speech is the content
    deltas.push({
      type: 'addFacet',
      facet: {
        id: `discord-msg-${messageId}`,
        type: 'event',
        // No content - content is in the nested speech facet
        state: {
          source: 'discord',
          eventType: 'discord-message',
          metadata: { 
            channelName, 
            author,
            authorId,
            isBot,
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
        },
        children: [speechFacet] // Speech nested inside message
      }
    });
    
    // Update lastRead in VEIL (nested facet pattern)
    deltas.push(...updateStateFacets(
      'discord-lastread',
      { [channelId]: messageId },
      state
    ));
    
    // Activate agent if the bot is mentioned or replied to
    // (History messages don't come through this receptor anymore)
    if (botUserId) {
      // Check if bot is mentioned
      const botMentioned = mentions?.users?.some((u: any) => u.id === botUserId);
      
      // Check if this is a reply to the bot
      const replyingToBot = reply?.authorId === botUserId;
      
      // Check for fallback activation pattern: "<activate AgentName>"
      // This allows testing even without proper Discord mentions
      const activatePattern = /<activate\s+([^>]+)>/i;
      const activateMatch = rawContent?.match(activatePattern);
      const fallbackActivate = activateMatch !== null && activateMatch !== undefined;
      
      if (botMentioned || replyingToBot || fallbackActivate) {
        const reason = botMentioned ? 'bot_mentioned' : 
                      replyingToBot ? 'bot_replied_to' : 
                      'fallback_activate';
        console.log(`[DiscordMessageReceptor] Creating agent activation (${reason}${fallbackActivate && activateMatch ? `: ${activateMatch[1]}` : ''})`);
      deltas.push({
        type: 'addFacet',
        facet: {
          id: `activation-${messageId}`,
          type: 'agent-activation',
            // No content - activations are metadata, not renderable content
          state: {
            source: 'discord-message',
              reason,
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
            }
            // Not ephemeral - this is valuable history of when/why agent activated
        }
      });
      } else {
        console.log(`[DiscordMessageReceptor] Skipping activation (bot not mentioned or replied to)`);
      }
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
    const { channelId, channelName, messages } = event.payload as any;
    const deltas: any[] = [];
    
    console.log(`[DiscordHistorySync] Syncing ${messages.length} messages for channel ${channelId}`);
    
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
    
    console.log(`[DiscordHistorySync] Found ${veilMessages.length} existing messages in VEIL, ${messages.length} in history`);
    
    for (const veilMsg of veilMessages) {
      const messageId = (veilMsg as any).attributes.messageId;
      
      // Extract content from nested speech facet (navigate children, not flat lookup)
      // Discord messages have speech as their first child
      const speechFacet = (veilMsg as any).children?.[0];
      const veilContent = speechFacet?.content || '';
      
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
        
        // Update the speech facet with new content
        if (speechFacet) {
          deltas.push({
            type: 'rewriteFacet',
            id: speechFacet.id,
            changes: {
              content: `${discordMsg.author}: ${discordMsg.content}` // Parsed content
            }
          });
        }
        
        // Update the message facet metadata (but not content - that's in speech)
        deltas.push({
          type: 'rewriteFacet',
          id: veilMsg.id,
          changes: {
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
    
    // Find messages in Discord history that aren't in VEIL yet (new messages)
    const veilMessageIds = new Set(veilMessages.map(v => (v as any).attributes.messageId));
    for (const msg of messages) {
      if (!veilMessageIds.has(msg.messageId)) {
        newMessages.push(msg);
      }
    }
    
    console.log(`[DiscordHistorySync] ${editedCount} edits, ${deletedCount} deletions, ${newMessages.length} new messages`);
    
    // Create a single parent facet for new history messages (if any)
    if (newMessages.length > 0) {
      const children: any[] = [];
      
      for (const msg of newMessages) {
        // Create nested message facet with speech child
        const speechFacet = {
          id: `speech-${msg.messageId}`,
          type: 'speech',
          content: msg.content,  // Just content, HUD will add speaker prefix
          state: {
            speakerId: `discord:${msg.authorId}`,
            speaker: msg.author
          }
        };
        
        children.push({
          id: `discord-msg-${msg.messageId}`,
          type: 'event',
          state: {
            source: 'discord',
            eventType: 'discord-message',
            metadata: {
              channelName,
              author: msg.author,
              authorId: msg.authorId,
              isBot: msg.isBot,
              rawContent: msg.rawContent,
              mentions: msg.mentions
            }
          },
          attributes: {
            channelId,
            messageId: msg.messageId,
            mentions: msg.mentions
          },
          children: [speechFacet]
        });
      }
      
      // Create parent history facet with all new messages as children
      deltas.push({
        type: 'addFacet',
        facet: {
          id: `discord-history-${channelId}-${Date.now()}`,
          type: 'event',
          displayName: 'discord-history',  // HUD can use this for wrapping
          state: {
            source: 'discord',
            eventType: 'discord-history-dump',
            metadata: {
              channelId,
              channelName,
              messageCount: newMessages.length
            }
          },
          attributes: {
            channelId,
            messageCount: newMessages.length
          },
          children  // All messages nested inside
        }
      });
    }
    
    return deltas;
  }
  
  private extractContent(fullContent: string | undefined): string {
    if (!fullContent) return '';
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
    const speechFacetId = `speech-${messageId}`;
    
    // Check if the message facet exists
    if (state.facets.has(facetId)) {
      // Update the speech facet with new content
      if (state.facets.has(speechFacetId)) {
        deltas.push({
          type: 'rewriteFacet',
          id: speechFacetId,
          changes: {
            content: `${author}: ${content}` // Use parsed content
          }
        });
      }
      
      // Update the message facet metadata (but not content - that's in speech)
      deltas.push({
        type: 'rewriteFacet',
        id: facetId,
        changes: {
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
 * Transform: Watches for infrastructure components and triggers Discord element creation
 * when all required components are ready. This ensures receptors exist before the
 * Discord afferent connects and emits discord:connected events.
 */
class DiscordInfrastructureTransform extends BaseTransform {
  priority = 100; // Run early in transform phase

  // Discord configuration (injected via component config)
  private discordConfig?: any;

  // Track which components we're waiting for
  private requiredComponents = new Set([
    'DiscordConnectedReceptor',
    'DiscordMessageReceptor',
    'DiscordHistorySyncReceptor',
    'DiscordMessageUpdateReceptor',
    'DiscordMessageDeleteReceptor',
    'DiscordSpeechEffector',
    'DiscordTypingEffector',
    'AgentEffector',
    'ActionEffector',
    'ContextTransform'
  ]);

  // Track if we've already triggered initialization
  private hasTriggered = false;

  process(state: ReadonlyVEILState): VEILDelta[] {
    if (this.hasTriggered) return [];

    // Wait for config to be injected
    if (!this.discordConfig) {
      console.log('[DiscordInfrastructure] Waiting for config...');
      return [];
    }

    // FLEX Phase 1: Check directly mounted components on Space instead of element-tree facets
    const space = this.element?.findSpace();
    if (!space) {
      console.log('[DiscordInfrastructure] Space not available yet...');
      return [];
    }

    // Get all components (now in flat list)
    const components = space.components || [];
    const mountedTypes = new Set(components.map((c: any) => c.constructor.name));

    // Check if all required components are present
    const allReady = [...this.requiredComponents].every(type => mountedTypes.has(type));

    if (!allReady) {
      console.log('[DiscordInfrastructure] Waiting for components... Have:', Array.from(mountedTypes), 'Need:', Array.from(this.requiredComponents));
      return [];
    }

    // FLEX Phase 1: Check if DiscordAfferent already mounted (idempotent)
    const hasDiscordAfferent = components.some((c: any) => c.constructor.name === 'DiscordAfferent');
    if (hasDiscordAfferent) {
      console.log('[DiscordInfrastructure] DiscordAfferent already exists, skipping creation');
      this.hasTriggered = true;
      return [];
    }

    console.log('[DiscordInfrastructure] All components ready - creating DiscordAfferent via element:create (will be shimmed)');
    this.hasTriggered = true;

    // Create element:create event - this will be shimmed to direct component mounting
    // The ElementTreeMaintainer will intercept this and mount DiscordAfferent directly to Space
    return [{
      type: 'addFacet',
      facet: {
        id: 'element-tree-discord',
        type: 'element-tree',
        state: {
          elementId: 'discord',
          elementType: 'Element',
          parentId: 'root',
          name: 'discord',
          active: true,
          components: [{
            type: 'DiscordAfferent',
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
          }]
        }
      }
    }];
  }
}

/**
 * Effector: Auto-joins Discord channels when connected
 * Config-based for VEIL persistence
 */
class DiscordAutoJoinEffector extends BaseEffector {
  facetFilters = [{ type: 'event' }];

  private discordAfferent?: any; // FLEX Phase 1: Direct component reference
  private channels: string[] = [];

  async onMount(): Promise<void> {
    // FLEX Phase 1: Find DiscordAfferent component directly in flat list
    const space = this.element?.findSpace();

    if (space) {
      this.discordAfferent = space.components.find((c: any) =>
        c.constructor.name === 'DiscordAfferent'
      );
      console.log(`[DiscordAutoJoinEffector] Found DiscordAfferent:`, !!this.discordAfferent);
    }
  }

  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    const events: SpaceEvent[] = [];

    // Lazy lookup: Try to find DiscordAfferent if we don't have it yet
    if (!this.discordAfferent) {
      const space = this.element?.findSpace();
      if (space) {
        this.discordAfferent = space.components.find((c: any) =>
          c.constructor.name === 'DiscordAfferent'
        );
        if (this.discordAfferent) {
          console.log('[DiscordAutoJoinEffector] Found DiscordAfferent on lazy lookup');
        }
      }
    }

    // Skip if not configured yet
    if (!this.discordAfferent || !this.channels || this.channels.length === 0) {
      return { events };
    }

    // Check if we have a discord:connected facet
    const hasConnected = changes.some(
      c => c.type === 'added' && c.facet.type === 'event' &&
      (c.facet as any).state?.eventType === 'discord-connected'
    );

    if (!hasConnected) {
      return { events };
    }

    console.log('🤖 Discord connected! Auto-joining channels:', this.channels);

    // Call join directly on the DiscordAfferent component
    for (const channelId of this.channels) {
      console.log(`📢 Calling join for channel: ${channelId}`);

      if (this.discordAfferent.join && typeof this.discordAfferent.join === 'function') {
        try {
          await this.discordAfferent.join({ channelId });
        } catch (error) {
          console.error(`Failed to join channel ${channelId}:`, error);
        }
      } else if (this.discordAfferent.actions && this.discordAfferent.actions.has('join')) {
        try {
          const handler = this.discordAfferent.actions.get('join');
          await handler({ channelId });
        } catch (error) {
          console.error(`Failed to join channel ${channelId}:`, error);
        }
      }
    }

    return { events };
  }
}

/**
 * Effector: Sends typing indicators when agent activates
 */
class DiscordTypingEffector extends BaseEffector {
  facetFilters = [{ type: 'agent-activation' }];

  private discordAfferent?: any; // FLEX Phase 1: Direct component reference

  async onMount(): Promise<void> {
    // FLEX Phase 1: Find DiscordAfferent component directly
    const space = this.element?.findSpace();
    if (space) {
      this.discordAfferent = space.components.find((c: any) =>
        c.constructor.name === 'DiscordAfferent'
      );
    }
  }

  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    const events: SpaceEvent[] = [];

    // Lazy lookup
    if (!this.discordAfferent) {
      const space = this.element?.findSpace();
      if (space) {
        this.discordAfferent = space.components.find((c: any) =>
          c.constructor.name === 'DiscordAfferent'
        );
      }
    }

    for (const change of changes) {
      if (change.type !== 'added' || change.facet.type !== 'agent-activation') continue;

      const activation = change.facet as any;
      const channelId = activation.state?.channelId || activation.state?.metadata?.channelId;

      if (!channelId) continue;

      console.log(`[DiscordTypingEffector] Sending typing indicator to channel: ${channelId}`);

      // Call sendTyping directly on DiscordAfferent
      if (this.discordAfferent?.sendTyping) {
        try {
          await this.discordAfferent.sendTyping({ channelId });
        } catch (error) {
          console.error(`Failed to send typing indicator:`, error);
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

  private discordAfferent?: any; // FLEX Phase 1: Direct component reference

  async onMount(): Promise<void> {
    // FLEX Phase 1: Find DiscordAfferent component directly in flat list
    const space = this.element?.findSpace();

    if (space) {
      this.discordAfferent = space.components.find((c: any) =>
        c.constructor.name === 'DiscordAfferent'
      );
      console.log(`[DiscordSpeechEffector] Found DiscordAfferent:`, !!this.discordAfferent);
    }
  }

  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    const events: SpaceEvent[] = [];

    // Lazy lookup: Try to find DiscordAfferent if we don't have it yet
    if (!this.discordAfferent) {
      const space = this.element?.findSpace();
      if (space) {
        this.discordAfferent = space.components.find((c: any) =>
          c.constructor.name === 'DiscordAfferent'
        );
        if (this.discordAfferent) {
          console.log('[DiscordSpeechEffector] Found DiscordAfferent on lazy lookup');
        }
      }
    }
    
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

      // Call send directly on DiscordAfferent
      if (!this.discordAfferent) {
        console.error('[DiscordSpeechEffector] DiscordAfferent not available (even after lazy lookup)');
        continue;
      }

      // Try send method first
      if (this.discordAfferent.send && typeof this.discordAfferent.send === 'function') {
        try {
          await this.discordAfferent.send(sendParams);
          console.log(`[DiscordSpeechEffector] Successfully sent message`);
        } catch (error) {
          console.error(`Failed to send to Discord:`, error);
        }
      } else if (this.discordAfferent.actions && this.discordAfferent.actions.has('send')) {
        // Fallback to actions map
        try {
          const handler = this.discordAfferent.actions.get('send');
          await handler(sendParams);
          console.log(`[DiscordSpeechEffector] Successfully sent message`);
        } catch (error) {
          console.error(`Failed to send to Discord:`, error);
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
    // Retrieve bot user ID from VEIL state
    const botConfigFacet = state.facets.get('discord-config-botUserId');
    const botUserId = botConfigFacet?.state?.value;

    if (!botUserId) {
      console.log(`[DiscordSpeechEffector] Bot user ID not found in VEIL, using fallback heuristic`);
    }

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
  
  async createSpace(hostRegistry?: Map<string, any>, lifecycleId?: string, spaceId?: string): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry, lifecycleId, spaceId);
    
    // The Host will inject the actual llmProvider based on the config
    // No need to register the ID here
    
    return { space, veilState };
  }
  
  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🎮 Initializing Discord application (fresh start)...');
    
    // Register all components FIRST (needed for component:add events)
    this.getComponentRegistry();

    // Element Tree infrastructure is now initialized by Host before initialize() is called
    // So we can immediately use element:create and component:add events

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

    // STEP 1: Add DiscordInfrastructureTransform first (watches for infrastructure readiness)
    console.log('🔧 Adding DiscordInfrastructureTransform...');
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        elementId: 'root',
        componentType: 'DiscordInfrastructureTransform',
        componentClass: 'transform',
        config: { discordConfig }
      }
    });


    // STEP 2: Add all RETM infrastructure components
    console.log('➕ Adding Discord RETM components...');

    // Add receptors
    const receptorTypes = [
      'DiscordConnectedReceptor',
      'DiscordMessageReceptor',
      'DiscordHistorySyncReceptor',
      'DiscordMessageUpdateReceptor',
      'DiscordMessageDeleteReceptor'
    ];

    for (const type of receptorTypes) {
      space.emit({
        topic: 'component:add',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          elementId: 'root',
          componentType: type,
          componentClass: 'receptor',
          config: {}
        }
      });
    }

    // Add DiscordSpeechEffector (needs discord element reference)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        elementId: 'root',
        componentType: 'DiscordSpeechEffector',
        componentClass: 'effector',
        config: { discordElementId: 'discord' }
      }
    });


    // Add DiscordTypingEffector (sends typing indicators on agent activation)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        elementId: 'root',
        componentType: 'DiscordTypingEffector',
        componentClass: 'effector',
        config: { discordElementId: 'discord' }
      }
    });

    // Add DiscordAutoJoinEffector if configured
    if (this.config.discord.autoJoinChannels && this.config.discord.autoJoinChannels.length > 0) {
      space.emit({
        topic: 'component:add',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          elementId: 'root',
          componentType: 'DiscordAutoJoinEffector',
          componentClass: 'effector',
          config: {
            channels: this.config.discord.autoJoinChannels,
            discordElementId: 'discord'
          }
        }
      });
    }

    // Add AgentEffector, ActionEffector, and ContextTransform
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        elementId: 'root',
        componentType: 'AgentEffector',
        componentClass: 'effector',
        config: { agentElementId: 'discord-agent' }
      }
    });

    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        elementId: 'root',
        componentType: 'ActionEffector',
        componentClass: 'effector',
        config: {}
      }
    });

    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        elementId: 'root',
        componentType: 'ContextTransform',
        componentClass: 'transform',
        config: {}
      }
    });

    // Wait for infrastructure components to be created
    await new Promise(resolve => setTimeout(resolve, 100));

    console.log('✅ Infrastructure components added - Discord element will be created when ready');

    // FLEX Phase 1: Check for directly mounted components instead of child elements
    // Since element:create is shimmed to component mounting, we check for component existence
    let existingAgentComponent = (space as any).getComponentById?.('discord-agent:AgentComponent');

    if (!existingAgentComponent) {
      console.log('🆕 Creating agent element via element:create event');
      
        const agentConfig = {
          name: this.config.agentName,
          systemPrompt: this.config.systemPrompt,
          autoActionRegistration: true
        };
      
      space.emit({
        topic: 'element:create',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          parentId: 'root',
          elementId: 'discord-agent',  // ✨ Predefined stable ID!
          name: 'discord-agent',
          elementType: 'Element',
          components: [
            {
              type: 'AgentComponent',
              config: { agentConfig } // Will be used to create agent in onReferencesResolved()
            }
          ]
        }
      });
      
      // Wait for component to be mounted
      await new Promise(resolve => setTimeout(resolve, 100));

      console.log('✅ Agent component created via shimming');
    } else {
      console.log('✅ Found existing agent component from persistence');
    }
    
    // Subscribe to agent response events
    space.subscribe('agent:frame-ready');

    // FLEX Phase 1: Check for box-dispenser component
    let existingBoxComponent = (space as any).getComponentById?.('box-dispenser:AgentComponent');

    if (!existingBoxComponent) {
      console.log('📦 Creating Box Dispenser element via element:create event');
      
      const boxAgentConfig = {
        name: 'Box Dispenser',
        systemPrompt: 'You are a helpful box dispenser. You dispense boxes. When asked, you cheerfully dispense a box and describe it.',
      autoActionRegistration: true
    };
    
      space.emit({
        topic: 'element:create',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          parentId: 'root',
          elementId: 'box-dispenser',  // ✨ Stable ID for testing
          name: 'box-dispenser',
          elementType: 'Element',
          components: [
            {
              type: 'AgentComponent',
              config: { agentConfig: boxAgentConfig }
            }
          ]
        }
      });
      
      // Wait for component to be mounted
      await new Promise(resolve => setTimeout(resolve, 100));

      console.log('✅ Box Dispenser component created via shimming');
    } else {
      console.log('✅ Found existing Box Dispenser component from persistence');
    }

    // FLEX Phase 1: Check for discord-control component
    let existingControlComponent = (space as any).getComponentById?.('discord-control:DiscordControlPanelComponent');

    if (!existingControlComponent) {
      console.log('📋 Creating Discord control panel via element:create event');
      
      space.emit({
        topic: 'element:create',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          parentId: 'root',
          elementId: 'discord-control',  // ✨ Predefined stable ID!
          name: 'discord-control',
          elementType: 'Element',
          components: [
            {
              type: 'DiscordControlPanelComponent',
              config: {
                _axonMetadata: {
                  moduleUrl: `http://localhost:${modulePort}/modules/discord-control-panel/module`,
                  manifestUrl: `http://localhost:${modulePort}/modules/discord-control-panel/manifest`
                }
              }
            }
          ]
        }
      });
      
      // Wait for component to be mounted
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      console.log('✅ Found existing Discord control panel component from persistence');
    }

    // FLEX Phase 1: Check for element-control component
    let existingElementControlComponent = (space as any).getComponentById?.('element-control:ElementControlComponent');

    if (!existingElementControlComponent) {
      console.log('🎮 Creating Element control panel via element:create event');
      
      space.emit({
        topic: 'element:create',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          parentId: 'root',
          elementId: 'element-control',  // ✨ Stable ID
          name: 'element-control',
          elementType: 'Element',
          components: [
            {
              type: 'ElementControlComponent',
              config: {
                _axonMetadata: {
                  moduleUrl: `http://localhost:${modulePort}/modules/element-control/module`,
                  manifestUrl: `http://localhost:${modulePort}/modules/element-control/manifest`
                }
              }
            }
          ]
        }
      });
      
      // Wait for element to be created
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      console.log('✅ Found existing Element control panel from persistence');
    }
    
    console.log('✅ Discord application initialized');
  }
  
  getComponentRegistry(): typeof ComponentRegistry {
    const registry = ComponentRegistry;
    
    // Register all components that can be restored
    // AxonLoaderComponent removed - AXON components are loaded on-demand by maintainer
    registry.register('AgentComponent', AgentComponent);
    registry.register('DiscordAutoJoinComponent', DiscordAutoJoinComponent);
    registry.register('DiscordAutoJoinEffector', DiscordAutoJoinEffector);

    // Register RETM components (stateless but need to be restored)
    registry.register('ElementRequestReceptor', ElementRequestReceptor);
    registry.register('ElementTreeTransform', ElementTreeTransform);
    registry.register('ElementTreeMaintainer', ElementTreeMaintainer);
    registry.register('DiscordInfrastructureTransform', DiscordInfrastructureTransform);
    registry.register('DiscordConnectedReceptor', DiscordConnectedReceptor);
    registry.register('DiscordMessageReceptor', DiscordMessageReceptor);
    registry.register('DiscordHistorySyncReceptor', DiscordHistorySyncReceptor);
    registry.register('DiscordMessageUpdateReceptor', DiscordMessageUpdateReceptor);
    registry.register('DiscordMessageDeleteReceptor', DiscordMessageDeleteReceptor);
    registry.register('DiscordSpeechEffector', DiscordSpeechEffector);
    registry.register('DiscordTypingEffector', DiscordTypingEffector);
    registry.register('AgentEffector', AgentEffector);
    registry.register('ActionEffector', ActionEffector);
    registry.register('ContextTransform', ContextTransform);
    registry.register('DiscordAutoJoinEffector', DiscordAutoJoinEffector);
    
    return registry;
  }
  
  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Discord application started!');
    
    // All RETM infrastructure components are now added during initialize()
    // The DiscordInfrastructureTransform will create the Discord element when ready
    // All AXON modules are loaded by ElementTreeMaintainer during component creation
    // Maintainer calls setConnectionParams which triggers connection and auto-join

    console.log('✅ Discord application ready - waiting for infrastructure to create Discord element');

    // No need to register tools - agent discovers them from action-definition facets in VEIL!
  }
  
  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored from snapshot');
    
    // All AXON modules are restored by ElementTreeMaintainer during Host.restore()
    // Maintainer loads modules, registers classes, creates components, and calls setConnectionParams
    // setConnectionParams triggers connection, and DiscordAfferent auto-joins configured channels
    
    console.log('✅ All connections re-established after restoration');
  }
}
