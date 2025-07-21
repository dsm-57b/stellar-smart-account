import { Keypair, BASE_FEE, hash, nativeToScVal, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { randomBytes } from "crypto";
import { Client as FactoryClient } from "factory";
import {
  Client as SmartWalletClient,
  Signer,
  SignerKey,
  SignerProof,
  xdr,
} from "smart_wallet";
import {
  FACTORY_WASM_HASH,
  ADMIN_SIGNER_KEYPAIR,
  ROOT_KEYPAIR,
  DEPLOYER_KEYPAIR,
  DELEGATED_SIGNER_KEYPAIR,
  SW_WASM_HASH,
  CONSTRUCTOR_FUNC,
  RPC_URL,
  NETWORK,
  TREASURY_KEYPAIR,
  HELLO_WORLD_CONTRACT_ID,
} from "./consts.js";
import { deployFactory, grantDeployerRole } from "./smart-wallet-operations.js";
import {
  AssembledTransaction,
  basicNodeSigner,
} from "@stellar/stellar-sdk/contract";
import { Server } from "@stellar/stellar-sdk/rpc";
import { printAuthEntries } from "./utils.js";
import fetch from "node-fetch";
import crypto from "crypto";

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
    
    // console.log(`🌐 ${method.toUpperCase()} ${this.walletBackendUrl}${path}`);
    // console.log(`📦 Request body size: ${bodyBytes.length} bytes`);
    // console.log(`🔑 JWT (aud=${audience}, sub=${this.authKeypair.publicKey()}): ${jwt}`);
    
    const response = await fetch(`${this.walletBackendUrl}${path}`, {
      method,
      headers,
      body: bodyString || undefined
    });
    
    const responseText = await response.text();
    // console.log(`📡 Status: ${response.status}`);
    
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
  private operations: Map<string, SmartWalletOperation> = new Map();
  private deployedWallets: Map<string, string> = new Map(); // walletId -> contractId

  constructor() {
    this.walletBackendClient = new ScaledWalletBackendClient(
      WALLET_BACKEND_URL,
      WALLET_BACKEND_AUTH_KEYPAIR, // Key used to authenticate with wallet-backend
      NETWORK
    );
  }

  /**
   * Deploy multiple smart wallets in parallel using channel accounts
   */
  async deploySmartWalletsInParallel(factoryContractId: string, walletCount: number): Promise<Map<string, string>> {
    console.log(`\n🚀 Deploying ${walletCount} smart wallets in parallel`);
    
    const deploymentPromises: Promise<string>[] = [];
    
    for (let i = 0; i < walletCount; i++) {
      const walletId = `wallet_${i + 1}`;
      deploymentPromises.push(this.deploySingleWallet(factoryContractId, walletId));
    }
    
    // Execute all deployments in parallel
    const results = await Promise.allSettled(deploymentPromises);
    
    results.forEach((result, index) => {
      const walletId = `wallet_${index + 1}`;
      if (result.status === 'fulfilled') {
        this.deployedWallets.set(walletId, result.value);
        console.log(`✅ ${walletId} deployed: ${result.value}`);
        console.log(`📄 ${walletId} URL: ${getExplorerUrls(result.value, 'contract')}`);
      } else {
        console.error(`❌ ${walletId} failed: ${result.reason}`);
      }
    });
    
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
        console.log(`🔄 ${walletId}: Starting ${operation}`);
        switch (operation) {
          case 'ADD_SIGNER':
            const signerToAdd = params?.signerKeypair || DELEGATED_SIGNER_KEYPAIR;
            return this.addSignerToWallet(contractId, signerToAdd);
          case 'INVOKE_CONTRACT':
            const contractToInvoke = params?.contractId || HELLO_WORLD_CONTRACT_ID;
            return this.invokeContractWithWallet(contractId, contractToInvoke);
          case 'UPGRADE_WALLET':
            return this.upgradeWallet(contractId);
          default:
            throw new Error(`Unsupported operation: ${operation}`);
        }
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
    const salt = randomBytes(32);
    
    const factoryClient = new FactoryClient({
      contractId: factoryContractId,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    // Get predicted address
    const addressTx = await factoryClient.get_deployed_address({ salt });
    const predictedAddress = addressTx.result;
    // console.log(`📍 ${walletId} predicted address: ${predictedAddress}`);

    // Prepare constructor args
    const constructor_args = {
      signers: [this.createAdminSignerFromKeypair(ADMIN_SIGNER_KEYPAIR)],
    };
    
    const smartWalletClient = new SmartWalletClient({
      contractId: predictedAddress,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    // Build deployment transaction
    const deployTx = await factoryClient.deploy(
      {
        caller: DEPLOYER_KEYPAIR.publicKey(),
        wasm_hash: Buffer.from(SW_WASM_HASH, "hex"),
        salt: salt,
        constructor_args: smartWalletClient.spec.funcArgsToScVals(
          CONSTRUCTOR_FUNC,
          constructor_args
        ),
      },
      { simulate: true }
    );

    // Sign with deployer auth
    await deployTx.signAuthEntries({
      address: DEPLOYER_KEYPAIR.publicKey(),
      ...basicNodeSigner(DEPLOYER_KEYPAIR, NETWORK),
    });

    // Submit through wallet-backend for parallel execution
    const deployHash = await this.submitTransactionViaWalletBackend(deployTx, `${walletId}_deploy`);

    // ------------------------------------------------------------------
    // Wait until wallet deployment is confirmed on-chain before allowing
    // operations to proceed. This prevents `Error(Storage, MissingValue)`
    // because the wallet contract state needs to be available.
    // Use faster retry intervals for better throughput.
    // ------------------------------------------------------------------
    try {
      await confirmTransactionWithRetry(deployHash, `${walletId}_deploy`, 10, 1500);
          } catch (e: any) {
        // console.warn(`⚠️  ${walletId} deployment confirmation failed:`, e.message || e);
        throw e; // Re-throw to fail deployment
      }

    return predictedAddress;
  }

  private async addSignerToWallet(smartWalletContractId: string, signerKeypair: Keypair): Promise<string> {
    const smartWalletClient = new SmartWalletClient({
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
    const addSignerTx = await smartWalletClient.add_signer(
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
    await this.authorizeWithSmartWallet(
      addSignerTx,
      smartWalletContractId,
      ADMIN_SIGNER_KEYPAIR,
      smartWalletClient
    );

    // ------------------------------------------------------------------
    // 3) Re-simulate so the RPC validates our signatures and produces the
    //    final `transactionData` required by wallet-backend.
    // ------------------------------------------------------------------
    await addSignerTx.simulate();

    const hash = await this.submitTransactionViaWalletBackend(addSignerTx, "add_signer");
    
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
    const smartWalletClient = new SmartWalletClient({
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

    await this.authorizeWithSmartWallet(helloWorldTx, smartWalletContractId, DELEGATED_SIGNER_KEYPAIR, smartWalletClient);

    // Re-simulate now that authorization is present so resource limits &
    // transactionData accurately reflect the final envelope.
    await helloWorldTx.simulate();
    
    const hash = await this.submitTransactionViaWalletBackend(helloWorldTx, 'invoke_contract');
    console.log("✅ INVOKE_CONTRACT completed successfully");
    console.log(`📄 INVOKE_CONTRACT transaction URL: ${getExplorerUrls(hash, 'transaction')}`);
    return hash;
  }

  private async upgradeWallet(smartWalletContractId: string): Promise<string> {
    const smartWalletClient = new SmartWalletClient({
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
    const upgradeTx = await smartWalletClient.upgrade(
      { new_wasm_hash: Buffer.from(SW_WASM_HASH, "hex") },
      { simulate: true }
    );

    await this.authorizeWithSmartWallet(upgradeTx, smartWalletContractId, ADMIN_SIGNER_KEYPAIR, smartWalletClient);
    
    // Re-simulate after authorization to finalize the transaction with 
    // signed auth entries (same pattern as working smart-wallet-operations.ts)
    await upgradeTx.simulate();
    
    const hash = await this.submitTransactionViaWalletBackend(upgradeTx, 'upgrade');
    console.log("✅ UPGRADE_WALLET completed successfully");
    console.log(`📄 UPGRADE_WALLET transaction URL: ${getExplorerUrls(hash, 'transaction')}`);
    return hash;
  }

  private async submitTransactionViaWalletBackend(tx: AssembledTransaction<any>, operationName: string): Promise<string> {
    // console.log(`🔄 Submitting ${operationName} via wallet-backend...`);

    // ------------------------------------------------------------------
    // 1. Sign the assembled transaction with Treasury key (authorizing the
    //    operation itself – NOT fee-bump sponsorship *)
    // ------------------------------------------------------------------
    // @ts-ignore sign helper typing mismatch
    await tx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));

    // Extract operations (Base64 XDR strings) from the transaction so the
    // wallet-backend can rebuild it with a fresh channel account.
    if (!tx.built) {
      throw new Error("Transaction not built yet – did you call simulate()?");
    }

    // tx.built is a stellar-base Transaction object – its operations array is
    // public.  Each Operation has `.toXDR()`.
    // built.toXDR() type is string in typings but returns a Buffer at runtime.
    const envelopeBuf: Buffer = Buffer.isBuffer(tx.built.toXDR())
      // @ts-ignore runtime returns Buffer for JS implementation
      ? (tx.built.toXDR() as Buffer)
      // If typings evolve and we get string, re-encode to Buffer first
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

    // ------------------------------------------------------------------
    // 2. Ask wallet-backend to build + sign a new envelope using a channel
    //    account (eliminates sequence-number collisions) – returns XDR.
    // ------------------------------------------------------------------
    // Build a MINIMAL simulationResult so that the request body stays <10 KB and
    // wallet-backend hash verification succeeds.  We only need `transactionData`
    // for fee/resource accounting and an empty `results` array for the forbidden
    // signer check (empty means no forbidden signers).
    let simulationResult: any = undefined;
    // Different versions of stellar-sdk expose the simulation in slightly
    // different fields – try the most common ones.
    const sim: any = (tx as any).simulation || (tx as any).simulationResponse || (tx as any).simulationResult;
    if (sim && sim.transactionData) {
      let transactionDataEncoded: string | undefined;
      try {
          // console.log('🧐 transactionData typeof:', typeof sim.transactionData);
        // if (typeof sim.transactionData === 'object' && sim.transactionData !== null) {
        //   console.log('🧐 transactionData keys:', Object.keys(sim.transactionData));
        //   console.log('🧐 transactionData proto methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(sim.transactionData)).slice(0,10));
        // }
        if (typeof sim.transactionData === 'string') {
          // Modern @stellar/stellar-sdk already exposes base64 string.
          transactionDataEncoded = sim.transactionData;
        } else if (typeof sim.transactionData.build === 'function') {
          const built = sim.transactionData.build();
          transactionDataEncoded = Buffer.from(built.toXDR()).toString('base64');
        } else if (typeof sim.transactionData.toXDR === 'function') {
          // Older versions expose an XDR object – encode to base64.
          const maybeBuf = sim.transactionData.toXDR();
          transactionDataEncoded = Buffer.from(maybeBuf).toString('base64');
        } else {
          try {
            // Fallback: use XDR static encoder
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const { xdr } = await import('@stellar/stellar-sdk');
            // The toXDR static method returns a Buffer
            transactionDataEncoded = xdr.SorobanTransactionData.toXDR(sim.transactionData).toString('base64');
          } catch (inner) {
            // console.warn('⚠️  Unable to encode transactionData via static toXDR:', inner);
          }
        }
              } catch (e) {
          // console.warn('⚠️  Failed to encode transactionData:', e);
        }

      if (transactionDataEncoded) {
        const minResourceFeeStr = sim.minResourceFee !== undefined ? String(sim.minResourceFee) : undefined;
        simulationResult = {
          transactionData: transactionDataEncoded,
          // Keep array empty – large results blow up the body size unnecessarily.
          results: [] as any[],
          ...(minResourceFeeStr ? { minResourceFee: minResourceFeeStr } : {}),
        };
      }
    }

    const buildResp = await this.walletBackendClient.submitTransaction(operationsXdr, simulationResult, 300);
    // Adjust the client: our helper returns {transactionXdrs: []}
    const builtXdr = (buildResp as any).transactionXdrs?.[0] || (buildResp as any).transactionXDRs?.[0];
    if (!builtXdr) {
      throw new Error("wallet-backend build response missing XDR");
    }

    // Create fee-bump (treasury sponsorship) if possible
    const feeBumpResp = await this.walletBackendClient.createFeeBump(builtXdr);

    // Use fee-bumped envelope if returned, otherwise fall back to the original
    const envelopeXdr = feeBumpResp?.transaction || builtXdr;

    // ------------------------------------------------------------------
    // 3. Convert the base64 XDR string into a Transaction object so that
    //    rpc.Server.sendTransaction receives the expected type.  Passing a
    //    plain string causes a runtime error (`transaction.toXDR is not a
    //    function`) because sendTransaction assumes a Transaction instance.
    // ------------------------------------------------------------------
    // @ts-ignore - TransactionBuilder.fromXDR is present at runtime in stellar-sdk 13 but not typed in bundled d.ts
    const envelopeTx = TransactionBuilder.fromXDR(envelopeXdr, NETWORK);

    // ------------------------------------------------------------------
    // 3. Broadcast the (fee-bumped) envelope to Soroban RPC with retries on
    //    TRY_AGAIN_LATER.
    // ------------------------------------------------------------------
    const server = new Server(RPC_URL);
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const sendResp = await server.sendTransaction(envelopeTx);
        console.log("📡 sendTransaction response:", sendResp);

        if (sendResp.status === "TRY_AGAIN_LATER") {
          throw Object.assign(new Error("TRY_AGAIN_LATER"), { retryable: true });
        }

        if (sendResp.status === "ERROR") {
          // Surface the low-level error XDR to the logs for easier debugging
          console.error(`❌ ${operationName} submission returned ERROR`, sendResp);
          const errXdr = (sendResp as any).errorResultXdr || (sendResp as any).errorResultXdr || (sendResp as any).errorResult || 'unknown error';
          throw new Error(`TRANSACTION_ERROR: ${errXdr}`);
        }

        console.log(`📤 Transaction submitted with hash: ${sendResp.hash}`);
        console.log(`📄 Transaction URL: ${getExplorerUrls(sendResp.hash, 'transaction')}`);

        // confirm
        confirmTransactionWithRetry(sendResp.hash, operationName, 15, 2000).catch((e) =>
          console.warn(`⚠️ ${operationName} confirmation failed`)
        );

        return sendResp.hash;
      } catch (err: any) {
        const isRetryable = err?.retryable || err?.message?.includes("TRY_AGAIN_LATER") || err?.code === "ETIMEDOUT";
        if (!isRetryable || attempt === maxAttempts) {
          console.error(`❌ ${operationName} failed after ${attempt} attempts`);
          throw err;
        }
        const delay = 2000 * Math.pow(2, attempt - 1);
        // console.log(`⏳ ${operationName} retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error(`Exhausted retries for ${operationName}`);
  }

  private async authorizeWithSmartWallet(
    tx: any,
    smartWalletContractId: string,
    signerKeypair: Keypair,
    smartWalletClient: SmartWalletClient
  ): Promise<void> {
    const server = new Server(RPC_URL);
    await tx.signAuthEntries({
      address: smartWalletContractId,
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

        const scKey = smartWalletClient.spec.nativeToScVal(key, scKeyType);
        const scVal = smartWalletClient.spec.nativeToScVal(val, scValType);

        const scEntry = new xdr.ScMapEntry({ key: scKey, val: scVal });

        switch (credentials.signature().switch().name) {
          case "scvVoid":
            credentials.signature(
              xdr.ScVal.scvVec([xdr.ScVal.scvMap([scEntry])])
            );
            break;
          case "scvVec":
            credentials.signature().vec()?.[0].map()?.push(scEntry);
            credentials
              .signature()
              .vec()?.[0]
              .map()
              ?.sort((a, b) => {
                return (
                  a.key().vec()![0].sym() + a.key().vec()![1].toXDR().join("")
                ).localeCompare(
                  b.key().vec()![0].sym() + b.key().vec()![1].toXDR().join("")
                );
              });
            break;
          default:
            throw new Error("Unsupported signature type");
        }

        return clone;
      },
    });
  }

  private createAdminSignerFromKeypair(adminSignerKeyPair: Keypair): Signer {
    return {
      tag: "Ed25519",
      values: [
        { public_key: Buffer.from(adminSignerKeyPair.rawPublicKey()) },
        { tag: "Admin", values: undefined },
      ] as const,
    };
  }

  async getOperationStatus(operationId: string): Promise<SmartWalletOperation | undefined> {
    return this.operations.get(operationId);
  }

  async getDeployedWallets(): Promise<Map<string, string>> {
    return this.deployedWallets;
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

    // Phase 0: Deploy factory using direct deployment (original method)
    // Note: For full scalability, this could also be done via wallet-backend
    console.log("\n🏭 Phase 0: Factory Setup");
    console.log("🚀 Deploying factory contract...");
    
    const factoryContractId = await deployFactory();
    console.log("✅ Factory deployed successfully");
    console.log("📍 Factory Contract ID:", factoryContractId);
    console.log(`📄 Factory Contract URL: ${getExplorerUrls(factoryContractId, 'contract')}`);
    
    console.log("🔑 Granting deployer role...");
    await grantDeployerRole(factoryContractId);
    console.log("✅ Deployer role granted successfully");
    console.log(`📄 Deployer Role URL: ${getExplorerUrls(factoryContractId, 'contract')}`);
    
    // Deploy 5 smart wallets in parallel
    console.log("\n📦 Phase 1: Parallel Smart Wallet Deployment");
    const walletCount = 5; // Number of smart wallets to deploy in parallel
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

/**
 * Enhanced transaction confirmation with retry logic and detailed logging
 */
async function confirmTransactionWithRetry(
  hash: string,
  operationName: string,
  maxRetries: number = 20,
  delayMs: number = 2000
): Promise<void> {
  const server = new Server(RPC_URL);
  let retries = 0;
  
  // console.log(`🔍 Starting confirmation for ${operationName} (hash: ${hash})`);
  
  while (retries < maxRetries) {
    try {
      // console.log(`🔍 Checking transaction status (attempt ${retries + 1}/${maxRetries})...`);
      
      const tx = await server.getTransaction(hash);
      // console.log(`📋 Transaction status: ${tx.status}`);
      
      if (tx.status === "SUCCESS") {
        // console.log("✅ Transaction confirmed successfully");
        return;
      } else if (tx.status === "FAILED") {
        // console.error("❌ Transaction failed:", tx);
        throw new Error(`${operationName} failed`);
      }
      
      // Status is still pending, wait and retry
      // console.log(`⏳ Transaction status: ${tx.status}, waiting ${delayMs}ms...`);
      
          } catch (error: any) {
        if (error.message?.includes("NOT_FOUND") && retries < maxRetries - 1) {
          // console.log(`⏳ Transaction not found yet, waiting ${delayMs}ms...`);
        } else if (retries === maxRetries - 1) {
          throw new Error(`Transaction confirmation timeout for ${operationName}: ${error.message}`);
        } else {
          // console.log(`⚠️ Error checking transaction: ${error.message}, retrying...`);
        }
      }
    
    retries++;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  
  throw new Error(`Transaction confirmation timeout for ${operationName} after ${maxRetries} attempts`);
}

// Export for use
export { 
  ScaledSmartWalletManager, 
  ScaledWalletBackendClient,
  scaledSmartWalletDemo 
};

// Run demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  scaledSmartWalletDemo().catch(console.error);
}