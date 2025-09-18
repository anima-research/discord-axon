#!/bin/bash

echo "🚀 Discord AXON Server Setup"
echo "=========================="

# Check if .env exists
if [ ! -f .env ]; then
  echo "📝 Creating .env file from template..."
  cp env.example .env
  echo "✅ Created .env file. Please edit it with your Discord bot token."
else
  echo "✅ .env file already exists"
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env and add your Discord bot token"
echo "2. Run 'npm start' to start the server"
echo "3. Or run 'npm run dev' for development mode with hot reload"
