# Discord Host Application Testing Guide

This guide explains how to test the Discord host application using MCP (Model Context Protocol) tools.

## Prerequisites

- Discord bot token configured in environment
- Access to a Discord server where the bot is invited
- MCP tools available in your environment

## Basic Testing Flow

### 1. Start the Services

First, kill any existing sessions and start fresh:

```bash
# Kill all existing sessions
mcp_connectome-session_killAll(graceful=true)

# Remove old state
run_terminal_cmd("cd /path/to/discord-axon && rm -rf discord-host-state")

# Start Discord AXON server
mcp_connectome-session_startService(
  name="discord-axon-server",
  command="npm run dev",
  cwd="/path/to/discord-axon",
  readyPatterns=["Bot logged in", "Module server"],
  errorPatterns=["Error", "Failed", "TOKEN"]
)

# Start Discord host application
mcp_connectome-session_startService(
  name="discord-host-app",
  command="npm run example:host",
  cwd="/path/to/discord-axon",
  readyPatterns=["Discord bot is running", "WebSocket connected", "Joining channel"],
  errorPatterns=["Failed to start", "Cannot find module"]
)
```

### 2. Monitor Connection Status

Check that the bot connected successfully:

```bash
# Search for connection logs
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="Discord.*connected|Joining channel|Bot logged in",
  context=5
)

# Check recent logs
mcp_connectome-session_tailLogs(
  session="discord-host-app",
  lines=50
)
```

### 3. Send Test Messages

Use Discord MCP tools to interact with the bot:

```bash
# Get server info first
mcp_mcp-server_get_server_info()

# List channels in a guild
mcp_mcp-server_list_channels(guildId="YOUR_GUILD_ID")

# Send a message that triggers the bot
mcp_mcp-server_send_message(
  channelId="YOUR_CHANNEL_ID",
  message="Hi! Can you help me?"
)

# Send a message with a keyword
mcp_mcp-server_send_message(
  channelId="YOUR_CHANNEL_ID",
  message="Hello connectome!"
)
```

### 4. Monitor Bot Responses

Check if the bot is processing messages correctly:

```bash
# Search for message processing logs
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="discord:message|Agent frame ready|speak operation",
  context=10
)

# Look for VEIL facets being created
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="discord-msg-|addEvent|addAmbient",
  context=5
)
```

### 5. Test Persistence

Test that state persists across restarts:

```bash
# Send a message to create state
mcp_mcp-server_send_message(
  channelId="YOUR_CHANNEL_ID",
  message="Remember this message"
)

# Gracefully shutdown (saves state)
mcp_connectome-session_sendSignal(
  session="discord-host-app",
  signal="SIGINT"
)

# Wait for "State saved" message
mcp_connectome-session_tailLogs(
  session="discord-host-app",
  lines=20
)

# Restart the host app
mcp_connectome-session_startService(
  name="discord-host-app-restored",
  command="npm run example:host",
  cwd="/path/to/discord-axon",
  readyPatterns=["Restoring from snapshot", "Discord.*connected"]
)

# Check that previous messages were restored
mcp_connectome-session_searchLogs(
  session="discord-host-app-restored",
  pattern="Restoring|discord-msg-|lastRead restored",
  context=5
)
```

### 6. Test Message Operations

Test various Discord operations:

```bash
# Edit a message
mcp_mcp-server_edit_message(
  channelId="YOUR_CHANNEL_ID",
  messageId="MESSAGE_ID",
  newMessage="Edited message content"
)

# Delete a message
mcp_mcp-server_delete_message(
  channelId="YOUR_CHANNEL_ID",
  messageId="MESSAGE_ID"
)

# Add a reaction
mcp_mcp-server_add_reaction(
  channelId="YOUR_CHANNEL_ID",
  messageId="MESSAGE_ID",
  emoji="👍"
)
```

### 7. Debug Connection Issues

If the bot isn't responding:

```bash
# Check Discord AXON server logs
mcp_connectome-session_searchLogs(
  session="discord-axon-server",
  pattern="Error|Failed|WebSocket|auth",
  context=10
)

# Check if bot is in the channel
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="joinedChannels|activeChannels|Joining channel",
  context=5
)
```

## Common Test Scenarios

### Test Agent Activation

1. Send a message with a trigger keyword:
```bash
mcp_mcp-server_send_message(
  channelId="YOUR_CHANNEL_ID",
  message="hi there!"
)
```

2. Check agent activation:
```bash
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="agent:frame-ready|AgentActivation|shouldRespond: true",
  context=10
)
```

### Test Message Deduplication

1. Send messages, restart, and check deduplication:
```bash
# Send test messages
mcp_mcp-server_send_message(channelId="...", message="Test 1")
mcp_mcp-server_send_message(channelId="...", message="Test 2")

# Restart host
mcp_connectome-session_sendSignal(session="discord-host-app", signal="SIGINT")
# ... restart ...

# Check deduplication logs
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="Deduplication|Filtered out|already in VEIL",
  context=5
)
```

### Test Multiple Channels

1. Get user ID for mentions:
```bash
mcp_mcp-server_get_user_id_by_name(
  guildId="YOUR_GUILD_ID",
  username="target_username"
)
```

2. Test direct messages:
```bash
mcp_mcp-server_send_private_message(
  userId="USER_ID",
  message="Private test message"
)
```

## Useful Log Patterns

Here are useful patterns to search for when debugging:

- Connection: `"Discord.*connected|WebSocket connected|authenticated"`
- Errors: `"Error|Failed|error|failed"`
- Message flow: `"discord:message|handleEvent|processAxonMessage"`
- VEIL operations: `"addFacet|changeState|addEvent|addAmbient"`
- Agent activation: `"agent:activate|agent:frame-ready|speak operation"`
- Persistence: `"Saving state|Loading state|Restoring|snapshot"`

## Tips

1. **Always check both sessions**: Problems might be in either `discord-axon-server` or `discord-host-app`

2. **Use context in searches**: When searching logs, use `context=5` or more to see surrounding lines

3. **Test incrementally**: Start with basic connection, then messages, then advanced features

4. **Monitor frame processing**: Many operations happen during frame processing, so look for `frame:start` and `frame:end`

5. **Check VEIL state**: Look for facet creation (`discord-msg-`, `discord-history-`) to ensure state is being tracked

## Troubleshooting

### Bot not responding to messages

1. Check if bot is in the channel:
```bash
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="Joining channel.*YOUR_CHANNEL_ID|joinedChannels",
  context=5
)
```

2. Check trigger configuration:
```bash
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="keywords:|mentions:|directMessages:",
  context=5
)
```

### Connection failures

1. Check bot token:
```bash
mcp_connectome-session_searchLogs(
  session="discord-host-app",
  pattern="token: SET|token: NOT SET",
  context=5
)
```

2. Check WebSocket connection:
```bash
mcp_connectome-session_searchLogs(
  session="discord-axon-server",
  pattern="WebSocket.*error|connection.*refused",
  context=10
)
```
