/**
 * Element Control Panel - Allows agents to create/manage components (formerly elements)
 */

import type { IPersistentMetadata } from '@connectome/axon-interfaces';
import type { IAxonEnvironmentV2 } from 'connectome-ts/src/axon/interfaces-v2';

export function createModule(env: IAxonEnvironmentV2) {
  const { InteractiveComponent, BaseReceptor } = env;
  
  class ElementControlComponent extends InteractiveComponent {
    static persistentProperties: IPersistentMetadata[] = [];
    
    setupSubscriptions(): void {
      // Subscribe to component:add events (replacing element:action which was generic)
      this.subscribe('component:add');
      console.log('[ElementControl] Subscribed to component:add');
    }
    
    onRestore(): void {
      // Re-establish subscriptions after restoration
      this.setupSubscriptions();
      console.log('[ElementControl] Restored and re-subscribed');
    }
    
    async onMount(): Promise<void> {
      // Call parent to subscribe to frame:start (if it exists)
      if (super.onMount) {
        await super.onMount();
      }
      
      console.log('[ElementControl] Component mounted');
      this.setupSubscriptions();
      
      // Register actions with descriptions
      this.registerAction('createComponent', async (params: any) => {
        const { componentId, componentType, config } = params;
        
        if (!componentType) {
          console.error('[ElementControl] createComponent requires componentType');
          this.addEvent(
            `Failed to create component: componentType required`,
            'component-create-error',
            `component-error-${Date.now()}`,
            { streamId: 'element-control' }
          );
          return;
        }
        
        console.log(`[ElementControl] Creating component: ${componentType} (${componentId})`);
        
        // Emit component:add event
        this.emit({
          topic: 'component:add',
          timestamp: Date.now(),
          payload: {
            componentId,
            componentType,
            config: config || {}
          }
        });
        
        this.addEvent(
          `Created component '${componentType}' (ID: ${componentId || 'auto'})`,
          'component-created',
          `component-created-${Date.now()}`,
          {
            streamId: 'element-control',
            componentId,
            componentType
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
        
        const componentId = `box-${boxName.toLowerCase().replace(/\s+/g, '-')}`;
        
        console.log(`[ElementControl] Creating box: ${boxName} (${componentId})`);
        
        // Emit component:add for a box with AgentComponent
        this.emit({
          topic: 'component:add',
          timestamp: Date.now(),
          payload: {
            componentId: `${componentId}:AgentComponent`,
            componentType: 'AgentComponent',
            config: {
              agentConfig: {
                name: boxName,
                systemPrompt: `You are ${boxName}, a helpful box that can store and dispense items.`,
                autoActionRegistration: true
              }
            }
          }
        });
        
        this.addEvent(
          `Created box '${boxName}' (ID: ${componentId})`,
          'box-created',
          `box-created-${Date.now()}`,
          {
            streamId: 'element-control',
            componentId,
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
      
      // console.log('[ElementControlActionsReceptor] component:mounted event:', payload);
      
      // Only process when ElementControlComponent is mounted
      if (payload.componentType !== 'ElementControlComponent') return [];
      
      console.log('[ElementControlActionsReceptor] ✨ Creating action-definition facets for element-control!');
      
      const deltas = [];
      const targetId = payload.componentId || 'element-control';
      
      // Create action-definition facet for createComponent
      deltas.push({
        type: 'addFacet',
        facet: {
          id: `action-def-${targetId}-createComponent`,
          type: 'action-definition',
          displayName: 'element-control.createComponent',
          attributes: {
            toolName: 'element-control.createComponent', // Map to this component ID?
            // If componentId is 'element-control:ElementControlComponent', tool might be 'element-control.createComponent'
            // ActionEffector uses prefix matching so 'element-control' prefix matches 'element-control:ElementControlComponent'
            actionName: 'createComponent',
            elementId: 'element-control', // Logical ID for grouping
            description: 'Create a new component with custom configuration',
            parameters: {
              type: 'object',
              properties: {
                componentId: { type: 'string', description: 'Unique ID for the component' },
                componentType: { type: 'string', description: 'Type of component to create' },
                config: { type: 'object', description: 'Configuration for the component' }
              },
              required: ['componentType']
            }
          }
        }
      });
      
      // Create action-definition facet for createBox
      deltas.push({
        type: 'addFacet',
        facet: {
          id: `action-def-${targetId}-createBox`,
          type: 'action-definition',
          displayName: 'element-control.createBox',
          attributes: {
            toolName: 'element-control.createBox',
            actionName: 'createBox',
            elementId: 'element-control',
            description: 'Create a new box agent with the given name',
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
