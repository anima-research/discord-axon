/**
 * Element Control Panel - Allows agents to create/manage elements
 */

import type { IInteractiveComponent, IPersistentMetadata } from '@connectome/axon-interfaces';
import type { IAxonEnvironmentV2 } from 'connectome-ts/src/axon/interfaces-v2';

export function createModule(env: IAxonEnvironmentV2) {
  const { InteractiveComponent, BaseReceptor } = env;
  
  class ElementControlComponent extends InteractiveComponent {
    static persistentProperties: IPersistentMetadata[] = [];
    
    setupSubscriptions(): void {
      // Subscribe to element:action events so we can handle action calls
      this.element.subscribe('element:action');
      console.log('[ElementControl] Subscribed to element:action');
    }
    
    onRestore(): void {
      // Re-establish subscriptions after restoration
      this.setupSubscriptions();
      console.log('[ElementControl] Restored and re-subscribed');
    }
    
    async onMount(): Promise<void> {
      // Call parent to subscribe to frame:start (if it exists)
      if (super.onMount) {
        super.onMount();
      }
      
      console.log('[ElementControl] Component mounted');
      this.setupSubscriptions();
      
      // Register actions with descriptions
      this.registerAction('createElement', async (params: any) => {
        const { elementId, name, elementType, componentType, componentConfig } = params;
        
        if (!elementId || !name) {
          console.error('[ElementControl] createElement requires elementId and name');
          this.addEvent(
            `Failed to create element: elementId and name required`,
            'element-create-error',
            `element-error-${Date.now()}`,
            { streamId: 'element-control' }
          );
          return;
        }
        
        console.log(`[ElementControl] Creating element: ${name} (${elementId})`);
        
        // Build components array
        const components = [];
        if (componentType) {
          components.push({
            type: componentType,
            config: componentConfig || {}
          });
        }
        
        // Emit element:create event (parent is the Space)
        this.element.emit({
          topic: 'element:create',
          timestamp: Date.now(),
          payload: {
            parentId: 'root',
            elementId,
            name,
            elementType: elementType || 'Element',
            components
          }
        });
        
        this.addEvent(
          `Created element '${name}' (ID: ${elementId})`,
          'element-created',
          `element-created-${Date.now()}`,
          {
            streamId: 'element-control',
            elementId,
            name,
            componentCount: components.length
          }
        );
      });
      
      this.registerAction('createBox', async (params: any) => {
        const { boxName } = params;
        
        if (!boxName) {
          console.error('[ElementControl] createBox requires boxName');
          this.addEvent(
            `Failed to create box: boxName required`,
            'box-create-error',
            `box-error-${Date.now()}`,
            { streamId: 'element-control' }
          );
          return;
        }
        
        const elementId = `box-${boxName.toLowerCase().replace(/\s+/g, '-')}`;
        
        console.log(`[ElementControl] Creating box: ${boxName} (${elementId})`);
        
        // Emit element:create for a box with AgentComponent
        this.element.emit({
          topic: 'element:create',
          timestamp: Date.now(),
          payload: {
            parentId: 'root',
            elementId,
            name: elementId,
            elementType: 'Element',
            components: [
              {
                type: 'AgentComponent',
                config: {
                  agentConfig: {
                    name: boxName,
                    systemPrompt: `You are ${boxName}, a helpful box that can store and dispense items.`,
                    autoActionRegistration: true
                  }
                }
              }
            ]
          }
        });
        
        this.addEvent(
          `Created box '${boxName}' (ID: ${elementId})`,
          'box-created',
          `box-created-${Date.now()}`,
          {
            streamId: 'element-control',
            elementId,
            boxName
          }
        );
      });
    }
  }
  
  // Receptor to create action-definition facets when element-control mounts
  class ElementControlActionsReceptor extends BaseReceptor {
    topics = ['component:mounted'];
    
    transform(event: any, state: any): any[] {
      const payload = event.payload;
      
      console.log('[ElementControlActionsReceptor] component:mounted event:', payload);
      
      // Only process when ElementControlComponent is mounted on element-control
      if (payload.elementId !== 'element-control') return [];
      if (payload.componentType !== 'ElementControlComponent') return [];
      
      console.log('[ElementControlActionsReceptor] ✨ Creating action-definition facets for element-control!');
      
      const deltas = [];
      
      // Create action-definition facet for createElement
      deltas.push({
        type: 'addFacet',
        facet: {
          id: 'action-def-element-control-createElement',
          type: 'action-definition',
          content: 'Create a new element with custom configuration',
          displayName: 'element-control.createElement',
          attributes: {
            toolName: 'element-control.createElement',
            actionName: 'createElement',
            elementId: 'element-control',
            description: 'Create a new element with custom configuration',
            parameters: {
              type: 'object',
              properties: {
                elementId: { type: 'string', description: 'Unique ID for the element' },
                name: { type: 'string', description: 'Display name for the element' },
                elementType: { type: 'string', description: 'Type of element (default: Element)' },
                componentType: { type: 'string', description: 'Component to add to the element' },
                componentConfig: { type: 'object', description: 'Configuration for the component' }
              },
              required: ['elementId', 'name']
            }
          }
        }
      });
      
      // Create action-definition facet for createBox
      deltas.push({
        type: 'addFacet',
        facet: {
          id: 'action-def-element-control-createBox',
          type: 'action-definition',
          content: 'Create a new box element with the given name',
          displayName: 'element-control.createBox',
          attributes: {
            toolName: 'element-control.createBox',
            actionName: 'createBox',
            elementId: 'element-control',
            description: 'Create a new box element with the given name',
            parameters: {
              type: 'object',
              properties: {
                boxName: { type: 'string', description: 'Name of the box to create' }
              },
              required: ['boxName']
            }
          }
        }
      });
      
      return deltas;
    }
  }
  
  return {
    component: ElementControlComponent,
    receptors: {
      ElementControlActionsReceptor
    }
  };
}

