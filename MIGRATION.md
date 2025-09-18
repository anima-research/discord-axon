# Migration Guide

This guide helps you migrate from the scattered Discord implementation to the consolidated `discord-axon` repository.

## What Changed

### Before (Scattered Structure)
```
connectome-local/
├── examples/
│   ├── discord-combined-server.ts     # Main server (not tracked)
│   ├── discord-axon-server/           # Old standalone server
│   └── discord-axon-modules/          # Discord modules
│       └── src/
│           ├── discord-axon-refactored.ts
│           └── discord-chat-refactored.ts
├── axon-server/                       # Reusable library
└── lightweight-connectome/
    └── src/applications/discord-app.ts
```

### After (Consolidated Structure)
```
connectome-local/
├── discord-axon/                      # NEW: All Discord code
│   ├── server.ts                      # Combined server
│   ├── src/
│   │   ├── config.ts                  # Configuration loader
│   │   └── modules/                   # Discord AXON modules
│   │       ├── discord-axon-refactored.ts
│   │       └── discord-chat-refactored.ts
│   └── package.json
├── axon-server/                       # Unchanged: Reusable library
└── lightweight-connectome/
    └── src/applications/discord-app.ts # Updated: Uses port 8082
```

## Migration Steps

### 1. Stop Existing Servers

```bash
# Kill any running Discord servers
pkill -f "discord-combined-server"
pkill -f "discord-axon-server"
```

### 2. Set Up New Server

```bash
cd discord-axon
./setup.sh
```

### 3. Configure

Option A: Environment Variables
```bash
export DISCORD_BOT_TOKEN=your_token_here
```

Option B: Edit `.env` file
```bash
cp env.example .env
# Edit .env with your bot token
```

Option C: Use existing YAML config
The server will automatically look for:
- `./config.yaml`
- `./discord_config.yaml`
- `../connectome-adapters/config/discord_config.yaml`

### 4. Update Port Configuration

The new default ports are:
- HTTP API: 8080
- WebSocket: 8081
- Module Serving: 8082 (changed from 8080)

If you have custom ports in your config, update them:

```yaml
discord:
  modulePort: 8082  # Changed from 8080
```

### 5. Start New Server

```bash
# Production
npm start

# Development
npm run dev
```

### 6. Update Connectome Applications

No code changes needed! The `discord-app.ts` has been updated to use port 8082 by default.

## Cleanup (Optional)

After verifying everything works:

```bash
# Remove old directories
rm -rf examples/discord-axon-server
rm -rf examples/discord-axon-modules
rm examples/discord-combined-server.ts
```

## Troubleshooting

### "Module not found" errors
- Ensure you ran `npm install` in the discord-axon directory
- Check that `@connectome/axon-server` dependency is linked

### "Port already in use"
- The module port changed from 8080 to 8082
- Check no other services are using these ports

### "Cannot connect to Discord"
- Verify bot token is correctly set
- Check Discord bot has proper intents enabled
- Ensure bot is in your server

## Benefits of Consolidation

1. **Single Repository**: All Discord-related code in one place
2. **Proper Git Tracking**: No more untracked server files
3. **Clear Separation**: Discord functionality separate from core Connectome
4. **Easy Deployment**: Single `npm install` and `npm start`
5. **Better Configuration**: Flexible config loading (env, yaml, etc.)
6. **Consistent Ports**: Module serving on dedicated port 8082
