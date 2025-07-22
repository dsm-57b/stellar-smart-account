import { Keypair, BASE_FEE, hash, nativeToScVal, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { randomBytes } from "crypto";
import { Client as FactoryClient } from "factory";
import { xdr as factoryXdr } from "factory";
import {
  Client as SmartAccountClient,
  Signer,
  SignerKey,
  SignerProof,
  xdr,
} from "smart_account";
import {
  FACTORY_WASM_HASH,
  ADMIN_SIGNER_KEYPAIR,
  ROOT_KEYPAIR,
  DEPLOYER_KEYPAIR,
  DELEGATED_SIGNER_KEYPAIR,
  SA_WASM_HASH,
  CONSTRUCTOR_FUNC,
  RPC_URL,
  NETWORK,
  TREASURY_KEYPAIR,
  HELLO_WORLD_CONTRACT_ID,
} from "./consts.js";
import {
  AssembledTransaction,
  basicNodeSigner,
} from "@stellar/stellar-sdk/contract";
import { Server } from "@stellar/stellar-sdk/rpc";
import { printAuthEntries } from "./utils.js";
import fetch from "node-fetch";
import crypto from "crypto";

// ============================================================================
// StellarTransactionBroadcaster Interface Compatibility Types
// ============================================================================

/**
 * Broadcaster name types for identifying different broadcast implementations
 */
export type StellarTransactionBroadcasterName = 
  | "WALLET_BACKEND_BROADCASTER" 
  | "DIRECT_RPC_BROADCASTER"
  | "SCALED_WALLET_BROADCASTER";

/**
 * Input arguments for the broadcaster interface
 */
export type StellarTransactionBroadcasterInputArgs<T = unknown> = {
  createdAt: number; // Unix timestamp in milliseconds
  assembledTransaction: AssembledTransaction<T>;
  timeoutInSeconds?: number;
};

/**
 * Additional options for transaction broadcasting
 */
export interface TransactionBroadcastOptions {
  operationName?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  enableFeeBump?: boolean;
  treasuryKeypair?: Keypair;
}

/**
 * Result returned by the broadcaster
 */
export interface BroadcastResult {
  hash: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "TRY_AGAIN_LATER" | "ERROR";
  errorResultXdr?: string;
  feeBumpHash?: string;
  metadata?: {
    submittedAt: number;
    confirmedAt?: number;
    retryCount?: number;
    operationName?: string;
  };
}

/**
 * Main broadcaster interface
 */
export interface StellarTransactionBroadcaster<
  T extends StellarTransactionBroadcasterName = StellarTransactionBroadcasterName,
> {
  name: T;
  /**
   * Broadcasts a transaction to the Stellar network.
   * @param inputArgs The input arguments for the broadcaster.
   * @returns A result object with the transaction hash and initial submission status.
   */
  broadcast(
    inputArgs: StellarTransactionBroadcasterInputArgs,
    options?: TransactionBroadcastOptions
  ): Promise<BroadcastResult>;
}

/**
 * Scaled Wallet Backend Broadcaster Implementation
 * 
 * This broadcaster implements the StellarTransactionBroadcaster interface
 * and wraps the existing ScaledWalletBackendClient functionality for compatibility.
 */
export class ScaledWalletBackendBroadcaster implements StellarTransactionBroadcaster<"SCALED_WALLET_BROADCASTER"> {
  name: "SCALED_WALLET_BROADCASTER" = "SCALED_WALLET_BROADCASTER";
  private walletBackendClient: WalletBackendClient;

  constructor(walletBackendClient: WalletBackendClient) {
    this.walletBackendClient = walletBackendClient;
  }

  async broadcast(
    inputArgs: StellarTransactionBroadcasterInputArgs,
    options?: TransactionBroadcastOptions
  ): Promise<BroadcastResult> {
    const startTime = Date.now();
    const operationName = options?.operationName || 'transaction';
    const timeoutSeconds = inputArgs.timeoutInSeconds || 300;
    const maxRetries = options?.maxRetries || 6;
    
    try {
      // Use the internal wallet-backend submission logic
      const hash = await this.submitTransactionViaWalletBackend(
        inputArgs.assembledTransaction,
        operationName,
        timeoutSeconds,
        maxRetries,
        options?.retryDelayMs || 2000
      );

      return {
        hash,
        status: "PENDING", // Initial status - actual confirmation happens separately
        metadata: {
          submittedAt: startTime,
          operationName,
        }
      };
    } catch (error: any) {
      console.error(`❌ ${operationName} broadcast failed:`, error.message);
      
      // Parse error to determine appropriate status
      let status: BroadcastResult['status'] = "FAILED";
      let errorResultXdr: string | undefined;
      
      if (error.message?.includes("TRY_AGAIN_LATER")) {
        status = "TRY_AGAIN_LATER";
      } else if (error.message?.includes("TRANSACTION_ERROR")) {
        status = "ERROR";
        errorResultXdr = error.message.replace("TRANSACTION_ERROR: ", "");
      }

      return {
        hash: "",
        status,
        errorResultXdr,
        metadata: {
          submittedAt: startTime,
          operationName,
        }
      };
    }
  }

  /**
   * Internal method that implements the wallet-backend submission logic
   * for the broadcaster interface
   */
  private async submitTransactionViaWalletBackend(
    tx: AssembledTransaction<any>, 
    operationName: string,
    timeoutSeconds: number = 300,
    maxAttempts: number = 6,
    retryDelayBase: number = 2000
  ): Promise<string> {
    // Sign the assembled transaction with Treasury key
    // @ts-ignore sign helper typing mismatch
    await tx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));

    // Extract operations for wallet-backend
    if (!tx.built) {
      throw new Error("Transaction not built yet – did you call simulate()?");
    }

    const envelopeBuf: Buffer = Buffer.isBuffer(tx.built.toXDR())
      // @ts-ignore runtime returns Buffer for JS implementation
      ? (tx.built.toXDR() as Buffer)
      : Buffer.from(tx.built.toXDR() as string, "base64");
    const envelopeB64 = envelopeBuf.toString("base64");
    const envelope = (xdr.TransactionEnvelope as any).fromXDR(Buffer.from(envelopeB64, "base64"));
    
    let ops: any[] = [];
    switch (envelope.switch().name) {
      case "envelopeTypeTx":
        ops = envelope.v1().tx().operations();
        break;
      case "envelopeTypeTxV0":
        ops = envelope.v0().tx().operations();
        break;
      default:
        throw new Error("Unsupported envelope type " + envelope.switch().name);
    }
    const operationsXdr = ops.map((op: any) => op.toXDR().toString("base64"));

    // Prepare simulation result for wallet-backend
    let simulationResult: any = undefined;
    const sim: any = (tx as any).simulation || (tx as any).simulationResponse || (tx as any).simulationResult;
    if (sim && sim.transactionData) {
      let transactionDataEncoded: string | undefined;
      try {
        if (typeof sim.transactionData === 'string') {
          transactionDataEncoded = sim.transactionData;
        } else if (typeof sim.transactionData.build === 'function') {
          const built = sim.transactionData.build();
          transactionDataEncoded = Buffer.from(built.toXDR()).toString('base64');
        } else if (typeof sim.transactionData.toXDR === 'function') {
          const maybeBuf = sim.transactionData.toXDR();
          transactionDataEncoded = Buffer.from(maybeBuf).toString('base64');
        }
      } catch (e) {
        // Failed to encode, continue without
      }

      if (transactionDataEncoded) {
        const minResourceFeeStr = sim.minResourceFee !== undefined ? String(sim.minResourceFee) : undefined;
        simulationResult = {
          transactionData: transactionDataEncoded,
          results: [],
          ...(minResourceFeeStr ? { minResourceFee: minResourceFeeStr } : {}),
        };
      }
    }

    // Build transaction with wallet-backend
    const buildResp = await this.walletBackendClient.submitTransaction(operationsXdr, simulationResult, timeoutSeconds);
    const builtXdr = (buildResp as any).transactionXdrs?.[0] || (buildResp as any).transactionXDRs?.[0];
    if (!builtXdr) {
      throw new Error("wallet-backend build response missing XDR");
    }

    // Create fee-bump transaction
    const feeBumpResp = await this.walletBackendClient.createFeeBump(builtXdr);
    const envelopeXdr = feeBumpResp?.transaction || builtXdr;

    // Convert XDR to Transaction object
    // @ts-ignore - TransactionBuilder.fromXDR is present at runtime
    const envelopeTx = TransactionBuilder.fromXDR(envelopeXdr, NETWORK);

    // Submit to Stellar RPC with retries
    const server = new Server(RPC_URL);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const sendTransactionResponse = await server.sendTransaction(envelopeTx);

        if (sendTransactionResponse.status === "TRY_AGAIN_LATER") {
          throw Object.assign(new Error("TRY_AGAIN_LATER"), { retryable: true });
        }

        if (sendTransactionResponse.status === "ERROR") {
          console.error(`❌ ${operationName} submission returned ERROR`, sendTransactionResponse);
          const errXdr = (sendTransactionResponse as any).errorResultXdr || 
                        (sendTransactionResponse as any).errorResult || 'unknown error';
          throw new Error(`TRANSACTION_ERROR: ${errXdr}`);
        }

        console.log(`📤 Transaction submitted with hash: ${sendTransactionResponse.hash}`);
        console.log(`📄 Transaction URL: ${getExplorerUrls(sendTransactionResponse.hash, 'transaction')}`);

        return sendTransactionResponse.hash;
      } catch (err: any) {
        const isRetryable = err?.retryable || err?.message?.includes("TRY_AGAIN_LATER") || err?.code === "ETIMEDOUT";
        if (!isRetryable || attempt === maxAttempts) {
          console.error(`❌ ${operationName} failed after ${attempt} attempts`);
          throw err;
        }
        const delay = retryDelayBase * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error(`Exhausted retries for ${operationName}`);
  }
}

// ============================================================================
// Original Script Code (with broadcaster integration)
// ============================================================================

// Utility functions
async function confirmTransactionWithRetry(hash: string, operationName: string, maxRetries: number, delayMs: number): Promise<void> {
  const server = new Server(RPC_URL);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tx = await server.getTransaction(hash);
      if (tx.status === "SUCCESS") {
        return;
      } else if (tx.status === "FAILED") {
        throw new Error(`${operationName} transaction failed`);
      }
      // Status is "NOT_FOUND", retry
    } catch (error: any) {
      if (attempt === maxRetries) {
        throw new Error(`${operationName} confirmation failed after ${maxRetries} attempts: ${error.message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`${operationName} confirmation timed out after ${maxRetries} attempts`);
}

function encodeConstructorArgs(
  client: SmartAccountClient,
  signers: Signer[]
): xdr.ScVal[] {
  return client.spec
    .funcArgsToScVals(CONSTRUCTOR_FUNC, { signers })
    .map((sv) => {
      // Reparse through the Factory's XDR module to ensure class identity
      return factoryXdr.ScVal.fromXDR((sv as xdr.ScVal).toXDR());
    });
}

/**
 * Generate block explorer URLs for Stellar testnet
 */
function getExplorerUrls(identifier: string, type: 'account' | 'contract' | 'transaction' = 'account') {
  const baseUrl = 'https://stellar.expert/explorer/testnet';
  switch (type) {
    case 'account':
      return `${baseUrl}/account/${identifier}`;
    case 'contract':
      return `${baseUrl}/contract/${identifier}`;
    case 'transaction':
      return `${baseUrl}/tx/${identifier}`;
    default:
      return `${baseUrl}/account/${identifier}`;
  }
}

/**
 * Scaled Smart Wallet Operations using Wallet-Backend Infrastructure
 * 
 * This implementation demonstrates how to scale smart wallet operations by:
 * 1. Using wallet-backend's channel account pooling for parallel transactions
 * 2. Leveraging fee-bump transaction wrapping for treasury sponsorship
 * 3. Enabling simultaneous wallet deployments without sequence number conflicts
 * 4. Providing infrastructure for high-throughput smart wallet operations
 */

// Wallet-Backend Configuration
const WALLET_BACKEND_URL = 'http://localhost:8001';

// Determine which keypair to use for authenticating against wallet-backend.
// Provide it via CLIENT_AUTH_PRIVATE_KEY or DISTRIBUTION_ACCOUNT_PRIVATE_KEY
// environment variables. No hard-coded default secret is kept in the repo.
const AUTH_SECRET_KEY =
  (process.env.CLIENT_AUTH_PRIVATE_KEY ||
   process.env.DISTRIBUTION_ACCOUNT_PRIVATE_KEY ||
   ADMIN_SIGNER_KEYPAIR.secret()).trim();

const WALLET_BACKEND_AUTH_KEYPAIR = AUTH_SECRET_KEY
  ? Keypair.fromSecret(AUTH_SECRET_KEY)
  : TREASURY_KEYPAIR; // fallback to constant (may still work in local tests)

interface WalletBackendClient {
  submitTransaction(operationXdrs: string[], simulationResult: any, timeout?: number): Promise<{ transactionXdrs: string[] }>;
  createFeeBump(transactionXdr: string): Promise<{ transaction: string }>;
  isHealthy(): Promise<boolean>;
}

class ScaledWalletBackendClient implements WalletBackendClient {
  private walletBackendUrl: string;
  private authKeypair: Keypair;
  private networkPassphrase: string;

  constructor(walletBackendUrl: string, authKeypair: Keypair, networkPassphrase: string) {
    this.walletBackendUrl = walletBackendUrl;
    this.authKeypair = authKeypair;
    this.networkPassphrase = networkPassphrase;
  }

  async submitTransaction(operationXdrs: string[], simulationResult: any, timeout: number = 300): Promise<{ transactionXdrs: string[] }> {
    const buildRequest = {
      transactions: [{
        operations: operationXdrs,
        timeout: timeout,
        simulationResult
      }]
    };

    const result = await this.walletBackendRequest('POST', '/transactions/build', buildRequest);
    return result as { transactionXdrs: string[] };
  }

  async createFeeBump(transactionXdr: string): Promise<{ transaction: string }> {
    const feeBumpRequest = { transaction: transactionXdr };
    return await this.walletBackendRequest('POST', '/tx/create-fee-bump', feeBumpRequest);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.walletBackendUrl}/health`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  private async walletBackendRequest(method: string, path: string, body: any = null): Promise<any> {
    const bodyString = body ? JSON.stringify(body) : '';
    
    // The wallet-backend verifier only reads and hashes the first 10_240 bytes
    // of the request body (see DefaultMaxBodySize in jwt_http_signer_verifier.go).
    // We must mirror that logic when generating the JWT, otherwise hashes will
    // mismatch for payloads larger than that cutoff.
    const MAX_BODY_SIZE = 10_240; // 10 KB
    const bodyBytes = Buffer.from(bodyString, 'utf8');
    const hashInput = bodyBytes.length > MAX_BODY_SIZE ? bodyBytes.subarray(0, MAX_BODY_SIZE) : bodyBytes;
    const bodyHash = crypto.createHash('sha256').update(hashInput).digest('hex');
    const methodAndPath = `${method.toUpperCase()} ${path}`;
    
    // The JWT audience must match the wallet-backend server hostname that the server
    // itself believes it is running under (`SERVER_BASE_URL` env in wallet-backend).
    // In the local docker-compose this is "api" (see SERVER_BASE_URL=http://api:8001).
    // Allow overriding via WALLET_BACKEND_AUDIENCE env var for flexibility.
    const audience = process.env.WALLET_BACKEND_AUDIENCE || 'api';

    const jwt = this.createJWT(
      this.authKeypair,
      audience,
      this.authKeypair.publicKey(),
      methodAndPath,
      bodyHash
    );
    
    const headers = {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json'
    };
    
    const response = await fetch(`${this.walletBackendUrl}${path}`, {
      method,
      headers,
      body: bodyString || undefined
    });
    
    const responseText = await response.text();
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseText}`);
    }

    return responseText ? JSON.parse(responseText) : null;
  }

  private createJWT(keypair: Keypair, audience: string, subject: string, methodAndPath: string, bodyHash: string): string {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 4; // wallet-backend enforces max 5s token validity
    
    const header = { alg: 'EdDSA', typ: 'JWT' };
    const payload = { aud: audience, sub: subject, iat: now, exp: exp, methodAndPath: methodAndPath, bodyHash: bodyHash };
    
    const headerEncoded = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const message = `${headerEncoded}.${payloadEncoded}`;
    const messageBuffer = Buffer.from(message, 'utf8');
    const signature = keypair.sign(messageBuffer);
    const signatureEncoded = Buffer.from(signature).toString('base64url');
    
    return `${message}.${signatureEncoded}`;
  }
}

// Smart wallet operation tracker for parallel execution
interface SmartWalletOperation {
  id: string;
  type: 'DEPLOY_FACTORY' | 'GRANT_ROLE' | 'DEPLOY_WALLET' | 'ADD_SIGNER' | 'INVOKE_CONTRACT' | 'UPGRADE_WALLET';
  status: 'PENDING' | 'BUILDING' | 'SIGNING' | 'SUBMITTING' | 'COMPLETED' | 'FAILED';
  transaction?: AssembledTransaction<any>;
  result?: any;
  error?: string;
  walletId?: string;
  dependencies: string[];
}

class ScaledSmartWalletManager {
  private walletBackendClient: WalletBackendClient;
  private broadcaster: StellarTransactionBroadcaster<"SCALED_WALLET_BROADCASTER">;
  private operations: Map<string, SmartWalletOperation> = new Map();
  private deployedWallets: Map<string, string> = new Map(); // walletId -> contractId

  constructor() {
    this.walletBackendClient = new ScaledWalletBackendClient(
      WALLET_BACKEND_URL,
      WALLET_BACKEND_AUTH_KEYPAIR, // Key used to authenticate with wallet-backend
      NETWORK
    );
    
    // Initialize the broadcaster with the wallet-backend client
    this.broadcaster = new ScaledWalletBackendBroadcaster(this.walletBackendClient);
  }

  /**
   * Deploy a new factory contract for this session
   */
  async deployFactory(): Promise<string> {
    try {
      const deployTx = await FactoryClient.deploy(
        { admin: ROOT_KEYPAIR.publicKey() },
        {
          wasmHash: FACTORY_WASM_HASH,
          salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
          networkPassphrase: NETWORK,
          fee: BASE_FEE,
          rpcUrl: RPC_URL,
          publicKey: ROOT_KEYPAIR.publicKey(),
        }
      );

      await deployTx.simulate();
      await deployTx.sign(basicNodeSigner(ROOT_KEYPAIR, NETWORK));
      const result = await deployTx.send();
      const hash = result.sendTransactionResponse?.hash;
      if (!hash) {
        throw new Error("Factory deployment failed: " + JSON.stringify(result));
      }
      
      console.log("📤 Transaction submitted with hash:", hash);
      await confirmTransactionWithRetry(hash, "Factory deployment", 10, 1500);
      
      const contractId = deployTx.result.options.contractId;
      console.log("✅ Factory deployed successfully");
      console.log("📍 Factory contract ID:", contractId);
      console.log(`📄 Factory Contract URL: ${getExplorerUrls(contractId, 'contract')}`);
      
      // Grant 'deployer' role to DEPLOYER_KEYPAIR (matches single-wallet script)
      const factoryClient = new FactoryClient({
        contractId,
        networkPassphrase: NETWORK,
        rpcUrl: RPC_URL,
        allowHttp: false,
        publicKey: TREASURY_KEYPAIR.publicKey(),
      });

      console.log("🔑 Granting deployer role...");
      const grantRoleTx = await factoryClient.grant_role(
        {
          caller: ROOT_KEYPAIR.publicKey(),
          account: DEPLOYER_KEYPAIR.publicKey(),
          role: "deployer",
        },
        { simulate: true }
      );

      await grantRoleTx.signAuthEntries({
        address: ROOT_KEYPAIR.publicKey(),
        ...basicNodeSigner(ROOT_KEYPAIR, NETWORK),
      });
      await grantRoleTx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));

      const grantResult = await grantRoleTx.send();
      const grantHash = grantResult.sendTransactionResponse?.hash;
      if (!grantHash) {
        throw new Error("Grant role failed: " + JSON.stringify(grantResult));
      }
      
      console.log(`📤 Grant role tx hash: ${grantHash}`);
      await confirmTransactionWithRetry(grantHash, "Grant role", 10, 1500);
      console.log("✅ Deployer role granted successfully");
      console.log(`📄 Deployer Role URL: ${getExplorerUrls(contractId, 'contract')}`);
      
      return contractId;
    } catch (error) {
      console.error("❌ Factory deployment failed:", error);
      throw error;
    }
  }

  /**
   * Deploy multiple smart wallets in parallel using channel accounts
   */
  async deploySmartWalletsInParallel(factoryContractId: string, walletCount: number): Promise<Map<string, string>> {
    console.log(`🚀 Deploying ${walletCount} smart wallets in parallel\n`);

    // Create all deployment promises for parallel execution
    const deploymentPromises = [];
    for (let i = 0; i < walletCount; i++) {
      const walletId = `wallet_${i + 1}`;
      deploymentPromises.push(this.deploySingleWallet(factoryContractId, walletId));
    }
    
    // Execute all deployments in parallel (maximize throughput with channel accounts)
    const results = await Promise.allSettled(deploymentPromises);
    
    // Process results
    for (let i = 0; i < results.length; i++) {
      const walletId = `wallet_${i + 1}`;
      const result = results[i];
      
      if (result.status === 'fulfilled') {
        this.deployedWallets.set(walletId, result.value);
        console.log(`✅ ${walletId} deployed: ${result.value}`);
      } else {
        console.error(`❌ ${walletId} failed: ${result.reason}`);
      }
    }
    
    return this.deployedWallets;
  }

  /**
   * Execute operations on multiple wallets in parallel
   */
  async executeOperationsInParallel(operations: Array<{
    walletId: string;
    operation: 'ADD_SIGNER' | 'INVOKE_CONTRACT' | 'UPGRADE_WALLET';
    params?: any;
  }>): Promise<Map<string, any>> {
    console.log(`⚡ Executing ${operations.length} operations on ${this.deployedWallets.size} wallets...`);
    
    // Group operations by type for clear logging
    const operationCounts = operations.reduce((acc, { operation }) => {
      acc[operation] = (acc[operation] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log(`📋 Operations breakdown:`);
    Object.entries(operationCounts).forEach(([op, count]) => {
      console.log(`   - ${op}: ${count} operations`);
    });

    const walletOperationChains = new Map<string, Promise<any>>();
    this.deployedWallets.forEach((contractId, walletId) => {
      walletOperationChains.set(walletId, Promise.resolve());
    });

    for (const { walletId, operation, params } of operations) {
      const contractId = this.deployedWallets.get(walletId);
      if (!contractId) {
        throw new Error(`Wallet ${walletId} not deployed yet.`);
      }

      const currentChain = walletOperationChains.get(walletId)!;

      const newChain = currentChain.then(() => {
        return this.executeWalletOperation(walletId, contractId, operation);
      });
      walletOperationChains.set(walletId, newChain);
    }

    const allPromises = Array.from(walletOperationChains.values());
    const results = await Promise.allSettled(allPromises);
    const operationResults = new Map<string, any>();

    results.forEach((result, index) => {
      const walletId = Array.from(walletOperationChains.keys())[index];
      if (result.status === 'fulfilled') {
        operationResults.set(walletId, { status: 'Success' });
        console.log(`✅ ${walletId}: All operations completed successfully`);
      } else {
        operationResults.set(walletId, { status: 'Failed', error: result.reason });
        console.error(`❌ ${walletId}: Operation chain failed`);
      }
    });

    return operationResults;
  }

  private async deploySingleWallet(factoryContractId: string, walletId: string): Promise<string> {
    console.log(`🚀 Starting deployment for ${walletId}`);
    
    // Add timeout wrapper for RPC calls
    const withTimeout = <T>(promise: Promise<T>, ms: number, operation: string): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
        )
      ]);
    };

    const salt = randomBytes(32);
    console.log(`📍 ${walletId}: Generated salt: ${Buffer.from(salt).toString('hex').slice(0, 16)}...`);
    
    const factoryClient = new FactoryClient({
      contractId: factoryContractId,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    // Get predicted address
    const startTime = Date.now();
    
    let addressTx;
    
    // Retry logic for get_deployed_address
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000; // 1 second
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        addressTx = await withTimeout(factoryClient.get_deployed_address({ salt }), 30000, `get_deployed_address for ${walletId} (attempt ${attempt})`);
        break;
      } catch (error: any) {
        if (attempt === MAX_RETRIES) {
          throw new Error(`${walletId}: Failed to get deployed address after ${MAX_RETRIES} attempts: ${error.message}`);
        }
        console.log(`⚠️  ${walletId}: get_deployed_address attempt ${attempt} failed: ${error.message}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
    
    if (!addressTx) {
      throw new Error(`${walletId}: Failed to get deployed address after ${MAX_RETRIES} attempts`);
    }
    
    const predictedAddress = addressTx.result;
    // console.log(`📍 ${walletId} predicted address: ${predictedAddress}`);

    // Prepare constructor args
    const constructor_args = {
      signers: [this.createAdminSignerFromKeypair(ADMIN_SIGNER_KEYPAIR)],
    };
    
    const smartAccountClient = new SmartAccountClient({
      contractId: predictedAddress,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    // Build deployment transaction
    const deployTx = await (factoryClient as any).deploy(
      {
        caller: DEPLOYER_KEYPAIR.publicKey(),
        deployment_args: {
          wasm_hash: Buffer.from(SA_WASM_HASH, "hex"),
          salt: salt,
          constructor_args: encodeConstructorArgs(
            smartAccountClient,
            [this.createAdminSignerFromKeypair(ADMIN_SIGNER_KEYPAIR)]
          ),
        },
      },
      { simulate: true }
    );

    // Sign auth entries with DEPLOYER (required for factory authorization)
    try {
      await deployTx.signAuthEntries({
        address: DEPLOYER_KEYPAIR.publicKey(),
        ...basicNodeSigner(DEPLOYER_KEYPAIR, NETWORK),
      });
    } catch (authErr: any) {
      throw new Error(`${walletId}: Failed to sign auth entries: ${authErr.message}`);
    }

    // Submit via wallet-backend (using channel accounts)
    const broadcastResult = await this.broadcaster.broadcast(
      {
        createdAt: Date.now(),
        assembledTransaction: deployTx,
      },
      {
        operationName: `${walletId}_deploy`,
        maxRetries: 6,
        retryDelayMs: 2000,
      }
    );

    if (broadcastResult.status === "FAILED" || broadcastResult.status === "ERROR") {
      throw new Error(`${walletId} deployment broadcast failed: ${broadcastResult.errorResultXdr || 'Unknown error'}`);
    }

    const hash = broadcastResult.hash;

    // Wait for confirmation
    await confirmTransactionWithRetry(hash, `${walletId} deployment`, 10, 1000);

    return predictedAddress;
  }

  private async addSignerToWallet(smartWalletContractId: string, signerKeypair: Keypair): Promise<string> {
    const smartAccountClient = new SmartAccountClient({
      contractId: smartWalletContractId,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      // Use the wallet address itself as the invoker so that the internal
      // `require_auth()` passes without needing extra auth-entries.  This is
      // the standard pattern for custom-account contracts.
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    // Build the transaction WITHOUT simulating first, so we can attach the
    // required wallet authorization before hitting the RPC.  Simulation will
    // fail if the auth entry is missing.
    const addSignerTx = await smartAccountClient.add_signer(
      {
        signer: {
          tag: "Ed25519",
          values: [
            { public_key: Buffer.from(signerKeypair.rawPublicKey()) },
            { tag: "Standard", values: undefined },
          ] as const,
        },
      },
      { simulate: false }
    );

    // ------------------------------------------------------------------
    // 1) First simulation (without signatures) to let the RPC attach the
    //    *unsigned* auth entries we need to sign.
    // ------------------------------------------------------------------
    await addSignerTx.simulate();

    // ------------------------------------------------------------------
    // 2) Sign those auth entries with the existing Admin signer.
    // ------------------------------------------------------------------
    await this.authorizeWithSmartAccount(
      addSignerTx,
      smartWalletContractId,
      ADMIN_SIGNER_KEYPAIR,
      smartAccountClient
    );

    // ------------------------------------------------------------------
    // 3) Re-simulate so the RPC validates our signatures and produces the
    //    final `transactionData` required by wallet-backend.
    // ------------------------------------------------------------------
    await addSignerTx.simulate();

    // Use the broadcaster interface
    const broadcastResult = await this.broadcaster.broadcast(
      {
        createdAt: Date.now(),
        assembledTransaction: addSignerTx,
      },
      {
        operationName: "add_signer",
        maxRetries: 6,
        retryDelayMs: 2000,
      }
    );

    if (broadcastResult.status === "FAILED" || broadcastResult.status === "ERROR") {
      throw new Error(`ADD_SIGNER broadcast failed: ${broadcastResult.errorResultXdr || 'Unknown error'}`);
    }

    const hash = broadcastResult.hash;
    
    // ------------------------------------------------------------------
    // Wait for add_signer to be confirmed on-chain before allowing
    // subsequent operations that depend on this signer being available.
    // ------------------------------------------------------------------
    try {
      await confirmTransactionWithRetry(hash, "add_signer", 10, 1500);
              console.log("✅ ADD_SIGNER completed successfully");
              console.log(`📄 ADD_SIGNER transaction URL: ${getExplorerUrls(hash, 'transaction')}`);
            } catch (e: any) {
          // console.warn(`⚠️  add_signer confirmation failed:`, e.message || e);
          throw e; // Re-throw to fail the operation chain
        }
    
    return hash;
  }

  private async invokeContractWithWallet(smartWalletContractId: string, contractId: string): Promise<string> {
    const smartAccountClient = new SmartAccountClient({
      contractId: smartWalletContractId,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    const helloWorldTx = await AssembledTransaction.build<string[]>({
      method: "hello",
      args: [
        nativeToScVal(smartWalletContractId, { type: "address" }),
      ],
      contractId: contractId,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
      parseResultXdr: (xdrVal: xdr.ScVal) => {
        const xdrVec = xdrVal.vec();
        if (!xdrVec) throw new Error("Expected a vector");
        return xdrVec.map((xdrItem) => xdrItem.str()).map((str) => str.toString());
      },
    });

    // ------------------------------------------------------------------
    // 1) Initial simulation to get the unsigned auth entries.
    // ------------------------------------------------------------------
    await helloWorldTx.simulate();

    await this.authorizeWithSmartAccount(helloWorldTx, smartWalletContractId, DELEGATED_SIGNER_KEYPAIR, smartAccountClient);

    // Re-simulate now that authorization is present so resource limits &
    // transactionData accurately reflect the final envelope.
    await helloWorldTx.simulate();
    
    // Use the broadcaster interface
    const broadcastResult = await this.broadcaster.broadcast(
      {
        createdAt: Date.now(),
        assembledTransaction: helloWorldTx,
      },
      {
        operationName: "invoke_contract",
        maxRetries: 6,
        retryDelayMs: 2000,
      }
    );

    if (broadcastResult.status === "FAILED" || broadcastResult.status === "ERROR") {
      throw new Error(`INVOKE_CONTRACT broadcast failed: ${broadcastResult.errorResultXdr || 'Unknown error'}`);
    }

    const hash = broadcastResult.hash;
    console.log("✅ INVOKE_CONTRACT completed successfully");
    console.log(`📄 INVOKE_CONTRACT transaction URL: ${getExplorerUrls(hash, 'transaction')}`);
    return hash;
  }

  private async upgradeWallet(smartWalletContractId: string): Promise<string> {
    const smartAccountClient = new SmartAccountClient({
      contractId: smartWalletContractId,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    // ------------------------------------------------------------------
    // Follow the exact same pattern as working smart-wallet-operations.ts:
    // 1. First simulate: true to get unsigned auth entries
    // 2. Authorize with smart wallet
    // 3. Re-simulate to finalize with signed auth entries
    // ------------------------------------------------------------------
    const upgradeTx = await smartAccountClient.upgrade(
      { new_wasm_hash: Buffer.from(SA_WASM_HASH, "hex") },
      { simulate: true }
    );

    await this.authorizeWithSmartAccount(upgradeTx, smartWalletContractId, ADMIN_SIGNER_KEYPAIR, smartAccountClient);
    
    // Re-simulate after authorization to finalize the transaction with 
    // signed auth entries (same pattern as working smart-wallet-operations.ts)
    await upgradeTx.simulate();
    
    // Use the broadcaster interface
    const broadcastResult = await this.broadcaster.broadcast(
      {
        createdAt: Date.now(),
        assembledTransaction: upgradeTx,
      },
      {
        operationName: "upgrade",
        maxRetries: 6,
        retryDelayMs: 2000,
      }
    );

    if (broadcastResult.status === "FAILED" || broadcastResult.status === "ERROR") {
      throw new Error(`UPGRADE_WALLET broadcast failed: ${broadcastResult.errorResultXdr || 'Unknown error'}`);
    }

    const hash = broadcastResult.hash;
    console.log("✅ UPGRADE_WALLET completed successfully");
    console.log(`📄 UPGRADE_WALLET transaction URL: ${getExplorerUrls(hash, 'transaction')}`);
    return hash;
  }



  private createAdminSignerFromKeypair(keypair: Keypair): Signer {
    return {
      tag: "Ed25519",
      values: [
        { public_key: Buffer.from(keypair.rawPublicKey()) },
        { tag: "Admin", values: undefined },
      ] as const,
    };
  }

  private async authorizeWithSmartAccount(
    tx: any,
    smartAccountContractId: string,
    signerKeypair: Keypair,
    smartAccountClient: SmartAccountClient
  ): Promise<void> {
    const server = new Server(RPC_URL);
    await tx.signAuthEntries({
      address: smartAccountContractId,
      authorizeEntry: async (entry: any) => {
        const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
        const credentials = clone.credentials().address();

        let expiration = credentials.signatureExpirationLedger();
        if (!expiration) {
          const { sequence } = await server.getLatestLedger();
          expiration = sequence + 300 / 5; // assumes 5-second ledgers
        }
        credentials.signatureExpirationLedger(expiration);

        const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId: hash(Buffer.from(NETWORK)),
            nonce: credentials.nonce(),
            signatureExpirationLedger: credentials.signatureExpirationLedger(),
            invocation: clone.rootInvocation(),
          })
        );

        const payload = hash(preimage.toXDR());
        const signature = signerKeypair.sign(payload);
        const rawPublicKey = signerKeypair.rawPublicKey();

        const key: SignerKey = { tag: "Ed25519", values: [rawPublicKey] };
        const val: SignerProof = { tag: "Ed25519", values: [signature] };

        const scKeyType = xdr.ScSpecTypeDef.scSpecTypeUdt(
          new xdr.ScSpecTypeUdt({ name: "SignerKey" })
        );
        const scValType = xdr.ScSpecTypeDef.scSpecTypeUdt(
          new xdr.ScSpecTypeUdt({ name: "SignerProof" })
        );

        const scKey = smartAccountClient.spec.nativeToScVal(key, scKeyType);
        const scVal = smartAccountClient.spec.nativeToScVal(val, scValType);

        const scEntry = new xdr.ScMapEntry({ key: scKey, val: scVal });

        switch (credentials.signature().switch().name) {
          case "scvVoid":
            credentials.signature(
              xdr.ScVal.scvVec([xdr.ScVal.scvMap([scEntry])])
            );
            break;
          case "scvVec":
            // Add the new signature to the existing map
            credentials.signature().vec()?.[0].map()?.push(scEntry);

            credentials
              .signature()
              .vec()?.[0]
              .map()
              ?.sort((a, b) => {
                return (
                  a.key().str().toString().localeCompare(b.key().str().toString())
                );
              });
            break;
          default:
            throw new Error(
              `Unsupported signature type: ${credentials.signature().switch().name}`
            );
        }

        clone.credentials().address().signature(credentials.signature());
        return clone;
      },
    });
  }

  async getDeployedWallets(): Promise<Map<string, string>> {
    return this.deployedWallets;
  }

  /**
   * Get the StellarTransactionBroadcaster instance for external use
   * This allows direct access to the broadcaster interface for custom transactions
   */
  getBroadcaster(): StellarTransactionBroadcaster<"SCALED_WALLET_BROADCASTER"> {
    return this.broadcaster;
  }

  private async executeWalletOperation(walletId: string, walletAddress: string, operation: string): Promise<void> {
    try {
      switch (operation) {
        case 'ADD_SIGNER':
          const signerToAdd = DELEGATED_SIGNER_KEYPAIR;
          await this.addSignerToWallet(walletAddress, signerToAdd);
          break;
        case 'INVOKE_CONTRACT':
          const contractToInvoke = HELLO_WORLD_CONTRACT_ID;
          await this.invokeContractWithWallet(walletAddress, contractToInvoke);
          break;
        case 'UPGRADE_WALLET':
          await this.upgradeWallet(walletAddress);
          break;
        default:
          throw new Error(`Unsupported operation: ${operation}`);
      }
    } catch (error: any) {
      console.error(`❌ ${walletId}: Operation failed: ${error.message}`);
      throw error; // Re-throw to fail the operation chain
    }
  }
}

/**
 * Scaled Smart Wallet Demo - Deploy and operate multiple wallets in parallel
 */
async function scaledSmartWalletDemo() {
  console.log("🚀 STARTING SCALED SMART WALLET DEMO");
  console.log("🌐 Network:", NETWORK);
  console.log("🔗 RPC URL:", RPC_URL);
  console.log("💼 Wallet Backend:", WALLET_BACKEND_URL);
  
  console.log("\n🔑 Key Accounts:");
  console.log(`  - Treasury: ${TREASURY_KEYPAIR.publicKey()}`);
  console.log(`    📄 URL: ${getExplorerUrls(TREASURY_KEYPAIR.publicKey(), 'account')}`);
  console.log(`  - Admin Signer: ${ADMIN_SIGNER_KEYPAIR.publicKey()}`);
  console.log(`    📄 URL: ${getExplorerUrls(ADMIN_SIGNER_KEYPAIR.publicKey(), 'account')}`);
  console.log(`  - Delegated Signer: ${DELEGATED_SIGNER_KEYPAIR.publicKey()}`);
  console.log(`    📄 URL: ${getExplorerUrls(DELEGATED_SIGNER_KEYPAIR.publicKey(), 'account')}`);
  console.log(`  - Hello World Contract: ${HELLO_WORLD_CONTRACT_ID}`);
  console.log(`    📄 URL: ${getExplorerUrls(HELLO_WORLD_CONTRACT_ID, 'contract')}`);
  
  const startTime = Date.now();
  const manager = new ScaledSmartWalletManager();
  
  try {
    // Check wallet-backend health
    const isHealthy = await manager['walletBackendClient'].isHealthy();
    if (!isHealthy) {
      throw new Error("Wallet-backend is not healthy. Please start the service.");
    }
    console.log("✅ Wallet-backend is healthy");

    // Phase 0: Deploy factory
    console.log("\n🏭 Phase 0: Factory Setup");
    const factoryContractId = await manager.deployFactory();
    
    // Deploy smart accounts in parallel
    console.log("\n📦 Phase 1: Parallel Smart Wallet Deployment");
    const walletCount = 5; // Test parallel channel accounts
    const deployStartTime = Date.now();
    const deployedWallets = await manager.deploySmartWalletsInParallel(factoryContractId, walletCount);
    const deployTime = Date.now() - deployStartTime;
    
    console.log(`\n✅ Deployed ${deployedWallets.size} wallets:`);
    deployedWallets.forEach((contractId, walletId) => {
      console.log(`  ${walletId}: ${contractId}`);
      console.log(`📄 Wallet URL: ${getExplorerUrls(contractId, 'contract')}`);
    });
    console.log(`⏱️  Deployment phase completed in ${deployTime}ms (${(deployTime / walletCount).toFixed(0)}ms per wallet)`);

    // Execute operations on all wallets in parallel
    console.log("\n⚡ Phase 2: Parallel Smart Wallet Operations");
    const operations = Array.from(deployedWallets.keys()).flatMap(walletId => [
      { walletId, operation: 'ADD_SIGNER' as const },
      { walletId, operation: 'INVOKE_CONTRACT' as const },
      { walletId, operation: 'UPGRADE_WALLET' as const },
    ]);
    
    const operationsStartTime = Date.now();
    const operationResults = await manager.executeOperationsInParallel(operations);
    const operationsTime = Date.now() - operationsStartTime;
    
    console.log(`\n✅ Executed ${operationResults.size} operations:`);
    operationResults.forEach((result, operationKey) => {
      console.log(`  ${operationKey}: ${result.error ? '❌ ' + result.error : '✅ Success'}`);
    });
    console.log(`⏱️  Operations phase completed in ${operationsTime}ms (${(operationsTime / operations.length).toFixed(0)}ms per operation)`);

    const totalTime = Date.now() - startTime;
    const totalOperations = walletCount + operations.length;
    console.log("\n🎉 Scaled Smart Wallet Demo completed successfully!");
    console.log(`📊 Performance Summary:`);
    console.log(`  - Total time: ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);
    console.log(`  - Wallets deployed: ${walletCount} in ${deployTime}ms`);
    console.log(`  - Operations executed: ${operations.length} in ${operationsTime}ms`);
    console.log(`  - Total operations: ${totalOperations}`);
    console.log(`  - Average throughput: ${(totalOperations / (totalTime / 1000)).toFixed(2)} operations/second`);
    console.log(`  - Operations per wallet: 3 (add_signer + invoke_contract + upgrade)`);
    
    console.log("\n📄 Deployed Smart Wallets - Block Explorer Links:");
    deployedWallets.forEach((contractId, walletId) => {
      console.log(`  ${walletId}: ${getExplorerUrls(contractId, 'contract')}`);
    });
    
    console.log("💡 Key benefits demonstrated:");
    console.log("  - Parallel wallet deployments using channel accounts");
    console.log("  - No sequence number conflicts");
    console.log("  - Automatic fee-bump sponsorship");
    console.log("  - Scalable transaction infrastructure");
    
  } catch (error) {
    console.error("❌ Scaled demo failed:", error);
    process.exit(1);
  }
}

// ============================================================================
// StellarTransactionBroadcaster Usage Examples
// ============================================================================

/**
 * Example: Using the broadcaster interface directly for custom transactions
 */
async function customTransactionExample() {
  const manager = new ScaledSmartWalletManager();
  const broadcaster = manager.getBroadcaster();
  
  // Example: Deploy a custom contract using the broadcaster interface
  /*
  const customTransaction = await SomeContractClient.deploy({
    // ... deployment parameters
  });
  
  await customTransaction.simulate();
  await customTransaction.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));
  
  const result = await broadcaster.broadcast(
    {
      createdAt: Date.now(),
      assembledTransaction: customTransaction,
      timeoutInSeconds: 300,
    },
    {
      operationName: "custom_deploy",
      maxRetries: 3,
      retryDelayMs: 1500,
      enableFeeBump: true,
    }
  );
  
  if (result.status === "PENDING") {
    console.log(`✅ Custom transaction submitted: ${result.hash}`);
    console.log(`📄 Transaction URL: ${getExplorerUrls(result.hash, 'transaction')}`);
    
    // Wait for confirmation if needed
    await confirmTransactionWithRetry(result.hash, "custom_deploy", 10, 1500);
  } else {
    console.error(`❌ Custom transaction failed: ${result.errorResultXdr}`);
  }
  */
}

/**
 * Example: Creating a custom broadcaster implementation
 */
class DirectRpcBroadcaster implements StellarTransactionBroadcaster<"DIRECT_RPC_BROADCASTER"> {
  name: "DIRECT_RPC_BROADCASTER" = "DIRECT_RPC_BROADCASTER";
  private server: Server;
  private networkPassphrase: string;

  constructor(rpcUrl: string, networkPassphrase: string) {
    this.server = new Server(rpcUrl);
    this.networkPassphrase = networkPassphrase;
  }

  async broadcast(
    inputArgs: StellarTransactionBroadcasterInputArgs,
    options?: TransactionBroadcastOptions
  ): Promise<BroadcastResult> {
    const startTime = Date.now();
    const operationName = options?.operationName || 'direct_transaction';
    
    try {
      // Simple direct submission without wallet-backend infrastructure
      const result = await inputArgs.assembledTransaction.send();
      
      return {
        hash: result.sendTransactionResponse?.hash || "",
        status: "PENDING",
        metadata: {
          submittedAt: startTime,
          operationName,
        }
      };
    } catch (error: any) {
      return {
        hash: "",
        status: "FAILED",
        errorResultXdr: error.message,
        metadata: {
          submittedAt: startTime,
          operationName,
        }
      };
    }
  }
}

/**
 * Compatibility Summary:
 * 
 * The script is now compatible with the StellarTransactionBroadcaster interface through:
 * 
 * 1. **Type Definitions**: All required types are defined at the top of the file
 *    - StellarTransactionBroadcasterName
 *    - StellarTransactionBroadcasterInputArgs<T>
 *    - TransactionBroadcastOptions
 *    - BroadcastResult
 *    - StellarTransactionBroadcaster<T>
 * 
 * 2. **ScaledWalletBackendBroadcaster**: Implementation that wraps the existing
 *    wallet-backend infrastructure and provides the broadcaster interface
 * 
 * 3. **Integration**: The ScaledSmartWalletManager now uses the broadcaster
 *    interface internally and exposes it via getBroadcaster() for external use
 * 
 * 4. **Backward Compatibility**: All existing functionality is preserved while
 *    adding the new interface layer
 * 
 * 5. **Extensibility**: Easy to create additional broadcaster implementations
 *    (like DirectRpcBroadcaster) for different submission strategies
 * 
 * Key Benefits:
 * - Standardized interface for transaction broadcasting
 * - Rich metadata and error handling
 * - Support for different broadcasting strategies
 * - Maintains all existing wallet-backend features (channel accounts, fee-bumps)
 * - Clean separation of concerns
 */

// Run demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  scaledSmartWalletDemo().catch(console.error);
}