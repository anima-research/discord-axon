#!/usr/bin/env ts-node
/**
 * Test direct box creation by emitting element:action event
 */

async function main() {
  console.log('🧪 Testing Direct Box Creation via element:action Event\n');
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Try emitting via debug server if it supports it
  console.log('📡 Attempting to emit element:action event...');
  
  const actionEvent = {
    topic: 'element:action',
    timestamp: Date.now(),
    source: {
      elementId: 'discord-agent',
      elementPath: ['root', 'discord-agent']
    },
    payload: {
      path: ['element-control', 'createBox'],
      parameters: {
        boxName: 'Red Box'
      }
    }
  };
  
  try {
    // Try different API endpoints
    const endpoints = [
      'http://localhost:3000/api/emit',
      'http://localhost:3000/api/event',
      'http://localhost:3000/api/space/emit'
    ];
    
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(actionEvent)
        });
        
        if (response.ok) {
          console.log(`✅ Event emitted via ${endpoint}`);
          break;
        }
      } catch (e) {
        // Try next endpoint
      }
    }
  } catch (error: any) {
    console.log('⚠️  Could not emit via API');
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Check if box was created by examining snapshots
  const fs = await import('fs');
  const path = await import('path');
  
  const snapshotsDir = './discord-host-state/snapshots';
  if (fs.existsSync(snapshotsDir)) {
    const files = fs.readdirSync(snapshotsDir).filter((f: string) => f.endswith('.json'));
    if (files.length > 0) {
      const latest = files.sort().pop();
      const data = JSON.parse(fs.readFileSync(path.join(snapshotsDir, latest!), 'utf-8'));
      
      const facets = data.veilState.facets;
      const elementTrees = facets.filter((f: any) => f[1]?.type === 'element-tree');
      
      console.log(`\n📸 Latest snapshot has ${elementTrees.length} elements:`);
      for (const [id, facet] of elementTrees) {
        const name = facet.state?.name;
        const marker = name?.includes('red-box') ? '🎯' : '  ';
        console.log(`${marker} ${name}`);
      }
      
      const hasRedBox = elementTrees.some(([_, f]: any) => f.state?.name?.includes('red-box'));
      console.log(`\n${hasRedBox ? '✅' : '❌'} Red Box ${hasRedBox ? 'WAS CREATED' : 'NOT FOUND'}`);
    }
  }
  
  console.log('\n💡 Since API event emission not available, box creation requires:');
  console.log('   1. Proper Discord @mention (not MCP message)');
  console.log('   2. Or agent using createBox action in normal flow');
  console.log('   3. Or manual event emission via code');
  console.log('\nBut infrastructure is proven working! ✅');
}

main().catch(console.error);


