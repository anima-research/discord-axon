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

      // Subscribe to frame events
      this.element.subscribe('frame:start');

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

      // Don't emit VEIL operations in onMount - wait for first frame
    }

    async handleEvent(event: ISpaceEvent): Promise<void> {
      switch (event.topic) {
        case 'frame:start':
          // Emit initial ambient facet on first frame
          if (!this.hasEmittedAmbientFacet) {
            this.emitInitialAmbientFacet();
            this.hasEmittedAmbientFacet = true;
          }
          break;
      }
    }

    private emitInitialAmbientFacet(): void {
      console.log('[DiscordControlPanel] Emitting initial ambient facet');

      // Emit the tool-use-description ambient facet
      this.addFacet({
        id: 'discord-console-description',
        type: 'ambient',
        displayName: 'Discord Console',
        content: 'Discord management console available. Use @discord-control.open_console() to see available tools.',
        attributes: {
          category: 'discord-control',
          consoleState: 'closed'
        }
      });

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
    }
  }

  return DiscordControlPanelComponent;
}
