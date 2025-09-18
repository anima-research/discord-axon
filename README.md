# Discord AXON Server

A comprehensive Discord integration server for Connectome that combines:
- Discord bot connectivity via WebSocket
- AXON module serving with hot reload
- Real-time bidirectional communication

## Features

- ✅ **Combined Server**: Single process serves both Discord bot and AXON modules
- ✅ **WebSocket Communication**: Real-time bidirectional messaging
- ✅ **AXON Module Serving**: Dynamic TypeScript transpilation with sourcemaps
- ✅ **Hot Reload**: Changes to modules are reflected immediately
- ✅ **Multi-Agent Support**: Multiple Connectome agents can share one Discord bot
- ✅ **Persistent State**: Channel membership and read positions survive restarts
- ✅ **Message History**: Fetches unread messages when rejoining channels

## Architecture

```
┌─────────────────────┐     ┌────────────────────┐
│  Connectome Host    │     │  Discord Server    │
│  ┌───────────────┐  │     │                    │
│  │ AxonElement   │  │     │  ┌──────────────┐  │
│  │ (discord)     │◄─┼─────┼──┤ HTTP Module  │  │
│  └───────┬───────┘  │     │  │   Serving    │  │
│          │          │     │  └──────────────┘  │
│  ┌───────▼───────┐  │     │                    │
│  │DiscordAxon   │  │     │  ┌──────────────┐  │
│  │  Component    │◄─┼─────┼──┤  WebSocket   │  │
│  └───────────────┘  │     │  │    Server    │  │
└─────────────────────┘     │  └──────┬───────┘  │
                            │         │           │
                            │  ┌──────▼───────┐  │
                            │  │ Discord Bot  │  │
                            │  │   Client     │  │
                            │  └──────┬───────┘  │
                            └─────────┼───────────┘
                                      │
                                ┌─────▼─────┐
                                │  Discord  │
                                │    API    │
                                └───────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd discord-axon
npm install
```

### 2. Configure Discord Bot

Create a `.env` file or set environment variables:

```bash
DISCORD_BOT_TOKEN=your_bot_token_here
```

To get a bot token:
1. Go to https://discord.com/developers/applications
2. Create a new application
3. Go to Bot section
4. Reset Token to get your token
5. Enable these intents:
   - MESSAGE CONTENT INTENT
   - SERVER MEMBERS INTENT

### 3. Run the Server

```bash
# Production
npm start

# Development with hot reload
npm run dev

# With custom ports
HTTP_PORT=8082 WS_PORT=8083 npm run dev
```

### 4. Connect from Connectome

```typescript
// In your Connectome application
const discordElem = new AxonElement(space, {
  name: 'discord',
  axonUrl: `http://localhost:8082/discord-chat/manifest?` +
    `wsPort=8083&` +
    `token=${BOT_TOKEN}&` +
    `guild=${GUILD_ID}&` +
    `agent=${AGENT_NAME}&` +
    `keywords=hi,hello,help,?,connectome&` +
    `mentions=true&` +
    `directMessages=true&` +
    `cooldown=0`
});
```

## Module Structure

### `/src/modules/discord-axon-refactored.ts`
Core Discord connectivity component:
- WebSocket connection management
- Message queuing for frame context
- Channel join/leave operations
- Message sending

### `/src/modules/discord-chat-refactored.ts`
Chat interface extension:
- Agent activation triggers
- Keyword detection
- Mention handling
- Response routing

## API Endpoints

### Module Serving (HTTP)

- `GET /modules/:module/manifest` - Get module manifest with configuration
- `GET /modules/:module/module` - Get transpiled module code with sourcemaps

### Discord Operations (WebSocket)

Connect to `ws://localhost:8081` with authentication:

```json
{
  "type": "auth",
  "token": "bot_token",
  "guild": "guild_id",
  "agent": "agent_name"
}
```

## Development

### Adding New Modules

1. Create a new TypeScript file in `src/modules/`
2. Export a `createModule(env)` function
3. Register it in `server.ts`:

```typescript
await this.moduleServer.addModule('my-module', {
  name: 'my-module',
  path: join(modulesDir, 'my-module.ts'),
  manifest: {
    name: 'MyComponent',
    version: '1.0.0',
    // ... manifest details
  }
});
```

### Testing

```bash
# Run the server
npm run dev

# In another terminal, test with Connectome
cd lightweight-connectome
npm run host:discord
```

## Security

- Bot tokens are never exposed to clients
- Each connection is isolated to its guild
- WebSocket requires authentication
- CORS is configurable for module serving

## Troubleshooting

### "Invalid token" error
- Ensure DISCORD_BOT_TOKEN matches the token in your connection URL
- Check that the bot token is valid and not regenerated

### "Guild not found" error
- Bot must be invited to the guild
- Use correct guild ID (enable Developer Mode in Discord)

### Messages not appearing
- Check bot permissions in the channel
- Ensure MESSAGE CONTENT INTENT is enabled
- Verify the channel ID is correct

### Module loading errors
- Check TypeScript syntax in module files
- Ensure decorators are properly configured
- Look for transpilation errors in server logs
