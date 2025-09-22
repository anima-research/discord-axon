#!/bin/bash
# Script to start the Discord bot with a clean state

echo "🧹 Cleaning up old state..."
rm -rf discord-host-state/

echo "🚀 Starting Discord bot..."
npm run example:host "$@"
