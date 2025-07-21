#!/bin/bash

# =================================================================
# Wallet-Backend Setup Script for Scaled Smart Wallet Demo
# =================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WALLET_BACKEND_COMMIT="ccf96d4"

echo "🚀 Setting up Wallet-Backend for Scaled Smart Wallet Demo"
echo "============================================================"

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command_exists docker; then
    echo "❌ Docker is required but not installed."
    exit 1
fi

if ! command_exists docker-compose; then
    echo "❌ Docker Compose is required but not installed."
    exit 1
fi

if ! command_exists git; then
    echo "❌ Git is required but not installed."
    exit 1
fi

if ! command_exists pnpm; then
    echo "❌ pnpm is required but not installed. Run: npm install -g pnpm"
    exit 1
fi

echo "✅ All prerequisites satisfied"

# Check if tsx is available (either globally or in project)
if command_exists tsx; then
    echo "✅ Using global tsx"
elif [ -f "../package.json" ] && grep -q '"tsx"' "../package.json"; then
    echo "✅ Using tsx from project dependencies"
else
    echo "❌ tsx is not available."
    echo "   tsx should be installed as a dev dependency in the project"
    echo "   or install globally: pnpm add -g tsx"
    exit 1
fi

# Ask for wallet-backend directory
echo ""
read -p "📂 Enter the path where you want to clone wallet-backend (default: ../../../wallet-backend): " WALLET_BACKEND_DIR
WALLET_BACKEND_DIR=${WALLET_BACKEND_DIR:-"../../../wallet-backend"}

# Make absolute path
WALLET_BACKEND_DIR=$(realpath "$WALLET_BACKEND_DIR")

echo "📍 Wallet-backend will be set up at: $WALLET_BACKEND_DIR"

# Clone wallet-backend if it doesn't exist
if [ ! -d "$WALLET_BACKEND_DIR" ]; then
    echo ""
    echo "📥 Cloning wallet-backend repository..."
    git clone https://github.com/stellar/wallet-backend.git "$WALLET_BACKEND_DIR"
else
    echo "📁 Wallet-backend directory already exists"
fi

# Checkout specific commit
echo ""
echo "🔄 Checking out commit $WALLET_BACKEND_COMMIT..."
cd "$WALLET_BACKEND_DIR"
git fetch origin
git checkout "$WALLET_BACKEND_COMMIT"

echo "✅ Wallet-backend repository ready"

# Generate .env file
echo ""
echo "🔧 Generating .env configuration..."
cd "$SCRIPT_DIR/.."
pnpm setup:wallet-backend

if [ ! -f "wallet-backend/.env" ]; then
    echo "❌ Failed to generate .env file"
    exit 1
fi

echo "✅ .env file generated successfully"

# Copy files to wallet-backend directory
echo ""
echo "📋 Copying configuration files..."
cp "wallet-backend/.env" "$WALLET_BACKEND_DIR/"
cp "$SCRIPT_DIR/Dockerfile" "$WALLET_BACKEND_DIR/Dockerfile"
cp "$SCRIPT_DIR/docker-compose.yaml" "$WALLET_BACKEND_DIR/docker-compose.yaml"
cp "$SCRIPT_DIR/go.mod" "$WALLET_BACKEND_DIR/go.mod"
cp "$SCRIPT_DIR/go.sum" "$WALLET_BACKEND_DIR/go.sum"

echo "✅ Configuration files copied"

# Start services
echo ""
read -p "🚀 Start wallet-backend services now? (y/N): " START_SERVICES

if [[ $START_SERVICES =~ ^[Yy]$ ]]; then
    echo ""
    echo "🐳 Starting wallet-backend services..."
    cd "$WALLET_BACKEND_DIR"
    
    echo "🚀 Starting services in background..."
    export NUMBER_CHANNEL_ACCOUNTS=20 && docker compose up -d --build 
    
    echo ""
    echo "⏳ Waiting for services to be healthy (this may take 60-120 seconds)..."
    echo "💡 You can check logs with: cd $WALLET_BACKEND_DIR && docker-compose -f docker-compose.yaml logs -f api"
    
    # Wait for API health check
    for i in {1..60}; do
        if curl -s -f http://localhost:8001/health > /dev/null 2>&1; then
            echo "✅ Wallet-backend API is healthy!"
            break
        fi
        if [ $i -eq 60 ]; then
            echo "⚠️  Timeout waiting for wallet-backend to be healthy"
            echo "📋 Check logs: docker-compose -f docker-compose.yaml logs api"
            exit 1
        fi
        echo "   Attempt $i/60: Waiting for API health check..."
        sleep 2
    done
    
    echo ""
    echo "🎉 Setup complete! Services are running."
    echo ""
    echo "🚀 Next steps:"
    echo "   1. Go to examples directory: cd $SCRIPT_DIR/.."
    echo "   2. Install dependencies: pnpm install"
    echo "   3. Run scaled demo: pnpm run dev:scaled"
else
    echo ""
    echo "✅ Setup complete! To start services later:"
    echo "   cd $WALLET_BACKEND_DIR"
    echo "   docker-compose -f docker-compose.yaml up -d"
fi

echo ""
echo "📚 For more information, see:"
echo "   - README: $SCRIPT_DIR/Readme.md"
echo "   - Logs: docker-compose -f docker-compose.yaml logs -f api"
echo "   - Health: curl http://localhost:8001/health"
echo ""
echo "💡 To stop the stack: docker-compose -f docker-compose.yaml down" 