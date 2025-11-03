/**
 * Discord Control Panel Component
 *
 * Provides a console interface for Discord management via MARTEM architecture.
 * The console can be opened and closed, listing available Discord tools when open.
 */

// Import shared AXON types from the centralized package
import type {
  IInteractiveComponent,
  ISpaceEvent,
  IPersistentMetadata,
  IExternalMetadata,
  IAxonEnvironment
} from '@connectome/axon-interfaces';

// Module factory function
export function createModule(env: IAxonEnvironment): typeof env.InteractiveComponent {
  const {
    InteractiveComponent,
    persistent,
    external
  } = env;

  class DiscordControlPanelComponent extends InteractiveComponent {
    // Track whether we've emitted the initial ambient facet
    @persistent
    private hasEmittedAmbientFacet: boolean = false;

    // Static metadata for persistence
    static persistentProperties: IPersistentMetadata[] = [
      { propertyKey: 'hasEmittedAmbientFacet' }
    ];

    async onMount(): Promise<void> {
      console.log('[DiscordControlPanel] Component mounted');

      // Register console actions
      this.registerAction('open_console', async () => {
        console.log('[DiscordControlPanel] open_console action called');
        // The Transform will handle updating the ambient facet
        // We just need to emit an event acknowledging the action
        this.addEvent(
          'Opening Discord console...',
          'discord-control:console-opening',
          `console-opening-${Date.now()}`,
          { ephemeral: true }
        );
      });

      this.registerAction('close_console', async () => {
        console.log('[DiscordControlPanel] close_console action called');
        // The Transform will handle updating the ambient facet
        // Emit event acknowledging the action
        this.addEvent(
          'Closing Discord console...',
          'discord-control:console-closing',
          `console-closing-${Date.now()}`,
          { ephemeral: true }
        );
      });

      // Register Discord channel actions
      this.registerAction('join', async (params: any) => {
        console.log('[DiscordControlPanel] join action called with params:', params);
        // Effector will handle bridging to Discord afferent
        this.addEvent(
          `Requesting to join channel ${params.channelId}`,
          'discord-control:join-requested',
          `join-requested-${Date.now()}`,
          { ephemeral: true, channelId: params.channelId }
        );
      });

      this.registerAction('leave', async (params: any) => {
        console.log('[DiscordControlPanel] leave action called with params:', params);
        // Effector will handle bridging to Discord afferent
        this.addEvent(
          `Requesting to leave channel ${params.channelId}`,
          'discord-control:leave-requested',
          `leave-requested-${Date.now()}`,
          { ephemeral: true, channelId: params.channelId }
        );
      });

      // Don't emit the ambient facet here - let the Transform manage it exclusively
      // We only register actions and emit action-definition facets
      if (!this.hasEmittedAmbientFacet) {
        this.emitActionDefinitions();
        this.hasEmittedAmbientFacet = true;
      }
    }

    async handleEvent(event: ISpaceEvent): Promise<void> {
      // No events to handle currently
    }

    private emitActionDefinitions(): void {
      console.log('[DiscordControlPanel] Emitting action definitions');

      // Emit action definition for open_console
      this.addFacet({
        id: 'discord-action-open_console',
        type: 'action-definition',
        displayName: 'Open Discord Console',
        attributes: {
          agentGenerated: false,
          toolName: 'open_console',
          parameters: {},
          actionName: 'open_console',
          category: 'discord-control',
          description: 'Opens the Discord management console to view available tools'
        }
      });

      // Emit action definition for close_console
      this.addFacet({
        id: 'discord-action-close_console',
        type: 'action-definition',
        displayName: 'Close Discord Console',
        attributes: {
          agentGenerated: false,
          toolName: 'close_console',
          parameters: {},
          actionName: 'close_console',
          category: 'discord-control',
          description: 'Closes the Discord management console'
        }
      });

      // Emit action definition for join
      this.addFacet({
        id: 'discord-action-join',
        type: 'action-definition',
        displayName: 'Join Discord Channel',
        attributes: {
          agentGenerated: false,
          toolName: 'join',
          parameters: {
            channelId: {
              type: 'string',
              required: true,
              description: 'The ID of the Discord channel to join'
            }
          },
          actionName: 'join',
          category: 'discord-control',
          description: 'Join a Discord channel by ID to start receiving messages'
        }
      });

      // Emit action definition for leave
      this.addFacet({
        id: 'discord-action-leave',
        type: 'action-definition',
        displayName: 'Leave Discord Channel',
        attributes: {
          agentGenerated: false,
          toolName: 'leave',
          parameters: {
            channelId: {
              type: 'string',
              required: true,
              description: 'The ID of the Discord channel to leave'
            }
          },
          actionName: 'leave',
          category: 'discord-control',
          description: 'Leave a Discord channel to stop receiving messages from it'
        }
      });
    }
  }

  return DiscordControlPanelComponent;
}
