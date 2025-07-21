#!/usr/bin/env tsx

/**
 * generate.env.ts - Generate .env file for wallet-backend from stellar smart account constants
 * 
 * This script reads the keypairs and constants from ../consts.ts and generates
 * a properly formatted .env file for wallet-backend with all the required keys.
 * 
 * Usage:
 *   Direct: tsx generate.env.ts
 *   Via pnpm: pnpm setup:wallet-backend
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Import constants from the parent examples directory
import {
  NETWORK,
  RPC_URL,
  ADMIN_SIGNER_KEYPAIR,
  DELEGATED_SIGNER_KEYPAIR,
  ROOT_KEYPAIR,
  DEPLOYER_KEYPAIR,
  TREASURY_KEYPAIR,
} from '../consts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function generateEnvFile(): void {
  console.log('🔧 Generating .env file for wallet-backend...');
  
  // Generate the .env content matching the provided .env.example format
  const envContent = `NETWORK=testnet
STELLAR_ENVIRONMENT=development
RPC_URL=${RPC_URL}

# Treasury and Admin keys for testing (derived from smart-wallet consts)
TREASURY_SECRET_KEY=${TREASURY_KEYPAIR.secret()}
ADMIN_SECRET_KEY=${ADMIN_SIGNER_KEYPAIR.secret()}

# Wallet-backend configuration
DISTRIBUTION_ACCOUNT_PRIVATE_KEY=${TREASURY_KEYPAIR.secret()}
DISTRIBUTION_ACCOUNT_PUBLIC_KEY=${TREASURY_KEYPAIR.publicKey()}
CLIENT_AUTH_PUBLIC_KEYS=${TREASURY_KEYPAIR.publicKey()},${ADMIN_SIGNER_KEYPAIR.publicKey()}
NUMBER_CHANNEL_ACCOUNTS=25
CHANNEL_ACCOUNT_ENCRYPTION_PASSPHRASE=my-super-secret-passphrase
DISTRIBUTION_ACCOUNT_SIGNATURE_PROVIDER=ENV
`;

  // Write the .env file
  const envPath = join(__dirname, '.env');
  writeFileSync(envPath, envContent, 'utf8');
  
  console.log('✅ Generated .env file successfully!');
  console.log(`📍 Location: ${envPath}`);
  console.log('\n🔑 Key Accounts:');
  console.log(`  Treasury (Fee Sponsor): ${TREASURY_KEYPAIR.publicKey()}`);
  console.log(`  Admin Signer: ${ADMIN_SIGNER_KEYPAIR.publicKey()}`);
  console.log(`  Delegated Signer: ${DELEGATED_SIGNER_KEYPAIR.publicKey()}`);
  console.log(`  Deployer: ${DEPLOYER_KEYPAIR.publicKey()}`);
  console.log(`  Root: ${ROOT_KEYPAIR.publicKey()}`);
  
  console.log('\n🚀 Next steps:');
  console.log('  1. Review the generated .env file');
  console.log('  2. Start wallet-backend: docker-compose -f docker-compose-local.yaml up');
  console.log('  3. Run the scaled demo: cd .. && pnpm run dev:scaled');
}

// Run the script
generateEnvFile();
