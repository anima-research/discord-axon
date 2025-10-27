#!/usr/bin/env ts-node
/**
 * Test dynamic box creation and persistence
 * Connects to running Discord host and creates a box element
 */

import WebSocket from 'ws';

async function main() {
  console.log('🧪 Testing dynamic box creation...\n');
  
  // Wait a moment for host to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Emit element:create event via HTTP (if debug server supports it)
  const response = await fetch('http://localhost:3000/api/space/emit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: 'element:create',
      payload: {
        parentId: 'root',
        elementId: 'dynamic-box-1',
        name: 'dynamic-box-1',
        elementType: 'Element',
        components: [
          {
            type: 'AgentComponent',
            config: {
              agentConfig: {
                name: 'Box Agent 1',
                systemPrompt: 'You are a helpful box that dispenses items.',
                autoActionRegistration: true
              }
            }
          }
        ]
      }
    })
  }).catch(err => {
    console.error('❌ Failed to emit event via API:', err.message);
    return null;
  });
  
  if (response && response.ok) {
    console.log('✅ Box creation event sent!');
  } else {
    console.log('⚠️  API not available, trying direct Space access...');
    
    // Alternative: Load the space state and check if we can emit
    const stateResponse = await fetch('http://localhost:3000/api/state');
    if (stateResponse.ok) {
      const state = await stateResponse.json();
      console.log('📊 Current state:', {
        spaceId: state.space?.id,
        children: state.space?.children?.length,
        facets: Object.keys(state.veil?.facets || {}).length
      });
    }
  }
  
  console.log('\n💡 For actual testing, use Discord command:');
  console.log('   @Connectome Opus4 create a box named "test-box-1"');
  console.log('\nOr manually check element-tree facets in latest snapshot.');
}

main().catch(console.error);


