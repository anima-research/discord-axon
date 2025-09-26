# Discord Message Deduplication

## Overview

The Discord AXON component now implements robust message deduplication to prevent duplicate messages from appearing in VEIL state, even when the `lastRead` tracking mechanism fails.

## The Problem

Previously, message deduplication relied solely on the `lastRead` tracking:
- Each channel tracked the ID of the last message that was processed
- New history dumps would filter out messages older than `lastRead`
- This worked well under normal circumstances

However, this approach failed in several scenarios:
1. **Failed persistence restoration** - If `lastRead` wasn't properly restored, all messages appeared "new"
2. **Deleted lastRead message** - If the tracked message was deleted from Discord, the filter could fail
3. **Multiple component instances** - Duplicate components had different `lastRead` values

These failures resulted in duplicate history dumps where messages already in VEIL were processed again, causing:
- Multiple bot responses to the same message
- Confusing conversation context for agents
- Unnecessary processing overhead

## The Solution

We now implement **two-layer deduplication**:

### Layer 1: LastRead Filtering (Existing)
```typescript
// Filter to only keep messages newer than lastRead
messages = messages.filter((m: any) => {
  return BigInt(m.messageId) > lastReadBigInt;
});
```

### Layer 2: VEIL State Deduplication (New)
```typescript
// Get all existing message IDs from VEIL for this channel
const existingMessageIds = new Set<string>();

// Check individual message facets
for (const [facetId, facet] of veilState.facets) {
  if (facetId.startsWith('discord-msg-') && 
      facet.attributes?.channelId === channelId &&
      facet.attributes?.messageId) {
    existingMessageIds.add(facet.attributes.messageId);
  }
}

// Also check messages within history event children
for (const [facetId, facet] of veilState.facets) {
  if (facetId.startsWith('discord-history-') && 
      facet.attributes?.channelId === channelId &&
      facet.children) {
    for (const child of facet.children) {
      if (child.attributes?.messageId) {
        existingMessageIds.add(child.attributes.messageId);
      }
    }
  }
}

// Filter out messages that already exist in VEIL
messages = messages.filter((m: DiscordMessage) => !existingMessageIds.has(m.messageId));
```

## How It Works

1. **Discord sends channel history** when:
   - A channel is joined
   - Connectome reconnects after being offline
   - Explicitly requested

2. **First filter by lastRead**:
   - Removes messages older than the last processed message
   - Fast and efficient for normal operation

3. **Second filter by VEIL state**:
   - Checks if message IDs already exist in VEIL
   - Catches any messages that passed the first filter but are duplicates
   - Works even when `lastRead` tracking fails

4. **Update lastRead**:
   - Always updates based on the original Discord messages
   - Ensures tracking stays current even if all messages were filtered

5. **Process only truly new messages**:
   - Only messages that pass both filters are added to VEIL
   - Prevents duplicate processing and confusion

## Benefits

- **Robust deduplication** - Works even when persistence fails
- **No duplicate bot responses** - Agents see each message only once
- **Cleaner VEIL state** - No redundant message facets
- **Better performance** - Less duplicate processing
- **Graceful degradation** - If one mechanism fails, the other still works

## Testing

To test the deduplication:

1. **Normal operation**:
   - Send messages in Discord
   - Restart Connectome
   - Verify no duplicate messages appear

2. **Failed persistence**:
   - Delete the persistence file
   - Restart Connectome
   - Verify existing messages aren't duplicated

3. **Offline deletion**:
   - Stop Connectome
   - Delete messages in Discord
   - Restart Connectome
   - Verify no duplicates, only truly new messages appear

## Future Improvements

- Consider adding a third layer using message timestamps
- Implement a message cache with TTL for recent messages
- Add metrics to track deduplication effectiveness
