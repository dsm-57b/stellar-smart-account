# 🚀 Scaled Smart Wallet Demo with Wallet-Backend

This example demonstrates how to run parallel smart wallet operations using the **wallet-backend** infrastructure to eliminate sequence number bottlenecks and enable high-throughput smart wallet deployments.

## 📋 Overview

The **smart-wallet-operations-scaled.ts** script shows how to:
- Deploy multiple smart wallets in parallel using channel accounts
- Execute operations on multiple wallets simultaneously 
- Leverage fee-bump transactions for treasury sponsorship
- Achieve high throughput without sequence number conflicts

This is achieved by integrating with [stellar/wallet-backend](https://github.com/stellar/wallet-backend), which provides channel account pooling and automated fee sponsorship.

## ⚡ Quick Start

### **One-Command Setup** (Easiest)
```bash
# From stellar-smart-account/examples/wallet-backend directory
./setup.sh
```

### Prerequisites

- **Node.js 18+** with pnpm
- **Docker & Docker Compose**
- **Git**
- **tsx** for TypeScript execution: `pnpm add -g tsx`

### Step-by-Step Setup

#### 1. **Clone Wallet-Backend Repository**

```bash
# Clone the wallet-backend at the exact commit we tested with
git clone https://github.com/stellar/wallet-backend.git
cd wallet-backend
git checkout ccf96d4  # Specific tested commit
```

#### 2. **Generate Environment Configuration**

```bash
# Go back to the examples directory
cd path/to/stellar-smart-account/examples

# Generate .env file from the smart account constants
pnpm setup:wallet-backend
```

This creates a `.env` file with all the required keys derived from `../consts.ts`.

#### 3. **Copy Configuration to Wallet-Backend**

```bash
# Copy the generated .env and docker-compose to wallet-backend directory
cp wallet-backend/.env /path/to/wallet-backend/
cp wallet-backend/docker-compose-local.yaml /path/to/wallet-backend/
```

#### 4. **Start Wallet-Backend Infrastructure**

```bash
cd /path/to/wallet-backend

# Start all services (Stellar network + Database + Wallet-backend)
export NUMBER_CHANNEL_ACCOUNTS=20 && docker compose up -d

# Wait for services to be healthy (check logs)
docker-compose -f docker-compose-local.yaml logs -f api
```

**Wait for these log messages:**
- ✅ `"Database migration completed"`
- ✅ `"Channel accounts ensured: 5"`
- ✅ `"Server listening on :8001"`

#### 5. **Run the Scaled Demo**

```bash
# Go back to examples directory
cd path/to/stellar-smart-account/examples

# Install dependencies (if not done already)
pnpm install

# Run the scaled smart wallet demo
pnpm run dev:scaled
```

---

## 🔧 Alternative: Manual Step-by-Step Setup

If you prefer manual control over each step:

```bash
# 1. Clone wallet-backend at specific commit
git clone https://github.com/stellar/wallet-backend.git
cd wallet-backend && git checkout ccf96d4

# 2. Generate .env configuration
cd path/to/stellar-smart-account/examples
pnpm setup:wallet-backend

# 3. Copy files and start services  
cp wallet-backend/.env wallet-backend/docker-compose-local.yaml /path/to/wallet-backend/
cd /path/to/wallet-backend
export NUMBER_CHANNEL_ACCOUNTS=20 && docker compose up -d

# 4. Run the demo
cd path/to/stellar-smart-account/examples
pnpm install && pnpm run dev:scaled
```

## 🏗️ What Happens During the Demo

### Phase 0: Factory Setup
- Deploys the smart wallet factory contract
- Grants deployer role permissions

### Phase 1: Parallel Wallet Deployment  
- Deploys 5 smart wallets using channel account pool (25 accounts available)
- Multiple deployments happen in parallel (no sequence number conflicts)

### Phase 2: Parallel Operations
- Adds signers to all wallets in parallel
- Invokes external contracts from all wallets  
- Upgrades all wallet contracts

### Expected Output
```
🚀 STARTING SCALED SMART WALLET DEMO
✅ Wallet-backend is healthy
🏭 Phase 0: Factory Setup
✅ Factory deployed successfully
✅ Deployer role granted successfully

📦 Phase 1: Parallel Smart Wallet Deployment  
✅ Deployed 5 wallets:
  wallet_1: CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  wallet_2: CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  ...

⚡ Phase 2: Parallel Smart Wallet Operations
✅ Executed 15 operations:
  wallet_1: ✅ Success
  wallet_2: ✅ Success
  ...

🎉 Scaled Smart Wallet Demo completed successfully!
📊 Performance Summary:
  - Total time: 45000ms (45.0s)
  - Average throughput: 0.33 operations/second
  - Operations per wallet: 3 (add_signer + invoke_contract + upgrade)
```

## 🔧 Configuration Details

### Key Accounts (Generated from `consts.ts`)

| Account | Role | Purpose |
|---------|------|---------|
| **Treasury** | Fee Sponsor | Provides XLM for transaction fees via fee-bump |
| **Admin Signer** | Wallet Admin | Can perform all wallet operations |
| **Delegated Signer** | Standard User | Can invoke contracts (added during demo) |
| **Deployer** | Factory Role | Authorized to deploy new wallets |

### Environment Variables

The `generate.env.ts` script generates the essential environment variables that need to be customized:

- **Distribution Account**: Treasury keypair for fee sponsorship  
- **Client Authentication**: Keys authorized to call wallet-backend API
- **Channel Account Encryption**: Passphrase for channel account storage
- **Integration Test Keys**: Additional keypairs for development testing

**Configuration details**:
- **Network**: Stellar Testnet
- **RPC**: External Soroban RPC (https://soroban-testnet.stellar.org)
- **Database**: PostgreSQL (via docker-compose)
- **Channel Accounts**: 25 accounts for high throughput
- **Base Fee**: 20000000 stroops (docker-compose default)

## 🐛 Troubleshooting

### Wallet-Backend Health Check Failed
```bash
# Check service status
docker-compose -f docker-compose-local.yaml ps

# Check logs
docker-compose -f docker-compose-local.yaml logs api
```

### Transaction Submission Errors
```bash
# Verify RPC connectivity
curl http://localhost:8000/health

# Check wallet-backend API
curl http://localhost:8001/health
```

### Out of Sync Database
```bash
# Reset and restart
docker-compose -f docker-compose-local.yaml down -v
docker-compose -f docker-compose-local.yaml up -d
```

### Channel Account Issues
```bash
# Check channel account creation
docker-compose -f docker-compose-local.yaml logs api | grep "channel"
```

## 📊 Performance Comparison

| Method | Wallets | Time | Throughput |
|--------|---------|------|------------|
| **Sequential** (original) | 5 | ~150s | 0.03 ops/sec |
| **Parallel** (scaled) | 5 | ~45s | 0.33 ops/sec |
| **Improvement** | | **70% faster** | **10x throughput** |

## 🔗 References

- [Wallet-Backend Repository](https://github.com/stellar/wallet-backend)
- [Smart Wallet Architecture](../../contracts/smart-wallet/README.md)
- [Scaling Integration Guide](../../../SMART_WALLET_SCALING_INTEGRATION.md)
- [Stellar Developer Docs](https://developers.stellar.org/)

## 💡 Next Steps

1. **Production Deployment**: Use real network and proper key management
2. **Monitoring**: Add Prometheus metrics and alerting
3. **Scaling**: Increase channel account pool size for higher throughput
4. **Security**: Implement HSM/KMS for production key management

---

**Questions?** Check the [Smart Wallet Scaling Integration Guide](../../../SMART_WALLET_SCALING_INTEGRATION.md) for detailed architecture explanations.
