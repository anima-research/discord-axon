#!/usr/bin/env ts-node
/**
 * Test runtime box creation via element-control action
 * Simulates what happens when agent calls @element-control.createBox("Red Box")
 */

async function main() {
  console.log('🧪 Testing Runtime Box Creation via Action\n');
  
  // Give host time to fully initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Call the element-control.createBox action via HTTP
  console.log('📞 Calling element-control.createBox("Red Box")...');
  
  try {
    const response = await fetch('http://localhost:8080/action/element-control/createBox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boxName: 'Red Box'
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log('✅ Action call succeeded:', result);
    } else {
      console.log('❌ Action call failed:', response.status, response.statusText);
      const text = await response.text();
      console.log('Response:', text);
    }
  } catch (error: any) {
    console.error('❌ Failed to call action:', error.message);
  }
  
  // Wait for element creation to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Check state via debug API
  console.log('\n📊 Checking current state...');
  
  try {
    const stateResponse = await fetch('http://localhost:3000/api/state');
    if (stateResponse.ok) {
      const state = await stateResponse.json();
      const space = state.space || {};
      const children = space.children || [];
      
      console.log(`\nSpace has ${children.length} children:`);
      for (const child of children) {
        const marker = child.name.includes('box') ? '🎯' : '  ';
        console.log(`${marker} ${child.name} (ID: ${child.id})`);
      }
      
      const hasRedBox = children.some((c: any) => c.name.includes('red-box'));
      console.log(`\n${hasRedBox ? '✅' : '❌'} Red Box ${hasRedBox ? 'CREATED' : 'NOT FOUND'}`);
    }
  } catch (error: any) {
    console.error('❌ Failed to check state:', error.message);
  }
  
  console.log('\n✅ Test complete');
}

main().catch(console.error);

