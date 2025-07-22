import { Keypair, BASE_FEE, hash, nativeToScVal } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import crypto from "crypto";
import { Client as FactoryClient } from "factory";
import { xdr as factoryXdr } from "factory";
import {
  Client as SmartAccountClient,
  Signer,
  SignerKey,
  SignerProof,
  xdr,
  Ed25519Signer,
  SignerRole,
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

/**
 * Example TypeScript application demonstrating smart account deployment and usage
 *
 * This example shows:
 * 1. Factory contract deployment with role-based access control
 * 2. Smart account deployment using the factory
 * 3. Signer management (add, update, revoke)
 * 4. Placeholder for transaction signing and submission
 */

/**
 * Utility function to confirm transaction completion
 */
async function confirmTransaction(
  hash: string,
  operationName: string
): Promise<void> {
  const server = new Server(RPC_URL);
  let status;
  do {
    const tx = await server.getTransaction(hash);
    status = tx.status;
  } while (status == "NOT_FOUND");

  if (status === "FAILED") {
    throw new Error(`${operationName} failed`);
  }
}

/**
 * Utility function to authorize transaction entries with smart account
 */
async function authorizeWithSmartAccount(
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
        expiration = sequence + 300 / 5; // assumes 5 second ledger time
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
      let key: SignerKey;
      let val: SignerProof | undefined;
      const signature = signerKeypair.sign(payload);
      const rawPublicKey = signerKeypair.rawPublicKey();
      if (Uint8Array.from(rawPublicKey).length !== 32) {
        throw new Error(
          "Invalid public key. It should be 32 bytes long, but is " +
            rawPublicKey.length
        );
      }
      if (Uint8Array.from(signature).length !== 64) {
        throw new Error(
          "Invalid signature. It should be 64 bytes long, but is " +
            signature.length
        );
      }
      key = {
        tag: "Ed25519",
        values: [rawPublicKey],
      };
      val = {
        tag: "Ed25519",
        values: [signature],
      };
      const scKeyType = xdr.ScSpecTypeDef.scSpecTypeUdt(
        new xdr.ScSpecTypeUdt({ name: "SignerKey" })
      );
      const scValType = xdr.ScSpecTypeDef.scSpecTypeUdt(
        new xdr.ScSpecTypeUdt({ name: "SignerProof" })
      );
      const scKey = smartAccountClient.spec.nativeToScVal(key, scKeyType);
      const scVal = val
        ? smartAccountClient.spec.nativeToScVal(val, scValType)
        : xdr.ScVal.scvVoid();
      const scEntry = new xdr.ScMapEntry({
        key: scKey,
        val: scVal,
      });

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
                a.key().vec()![0].sym() + a.key().vec()![1].toXDR().join("")
              ).localeCompare(
                b.key().vec()![0].sym() + b.key().vec()![1].toXDR().join("")
              );
            });
          break;
        default:
          throw new Error("Unsupported signature");
      }
      return clone;
    },
  });
}

/**
 * Helper to ensure ScVal objects have the correct class identity for the factory package.
 * When funcArgsToScVals from the smart_account package returns xdr.ScVal objects,
 * they have the class identity from smart_account's XDR module. The factory package
 * expects ScVal objects from its own XDR module for instanceof checks to pass.
 * Round-tripping through XDR ensures class identity compatibility between packages.
 */
function normalizeScVal(val: xdr.ScVal): xdr.ScVal {
  // `.toXDR()` gives us the raw bytes representing the ScVal union. We then
  // deserialize them again so `instanceof xdr.ScVal` checks succeed.
  return xdr.ScVal.fromXDR(val.toXDR());
}

/**
 * Encodes the constructor arguments (currently only the `signers` vector)
 * into the `ScVal` list expected by the factory's `deploy` call.
 */
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

// Normalize an array of ScVals so that each element uses the Factory bindings' XDR classes.
function toFactoryScVals(vals: xdr.ScVal[]): xdr.ScVal[] {
  return vals.map((v) => factoryXdr.ScVal.fromXDR(v.toXDR()));
}

/**
 * Step 1: Deploy the ContractFactory
 */
async function deployFactory(): Promise<string> {
  console.log("\n" + "=".repeat(60));
  console.log("🏭 STEP 1: DEPLOYING CONTRACT FACTORY");
  console.log("=".repeat(60));

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
    await confirmTransaction(hash, "Factory deployment");

    const contractId = deployTx.result.options.contractId;

    console.log("✅ Factory deployed successfully");
    console.log("📍 Factory contract ID:", contractId);

    return contractId;
  } catch (error) {
    console.error("❌ Factory deployment failed:", error);
    throw error;
  }
}

/**
 * Step 2: Grant deployer role to an address
 */
async function grantDeployerRole(factoryContractId: string): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🔑 STEP 2: GRANTING DEPLOYER ROLE");
  console.log("=".repeat(60));

  const factoryClient = new FactoryClient({
    contractId: factoryContractId,
    networkPassphrase: NETWORK,
    rpcUrl: RPC_URL,
    allowHttp: false,
    publicKey: TREASURY_KEYPAIR.publicKey(),
  });

  try {
    const grantRoleTx = await factoryClient.grant_role(
      {
        caller: ROOT_KEYPAIR.publicKey(),
        account: DEPLOYER_KEYPAIR.publicKey(),
        role: "deployer",
      },
      {
        simulate: true,
      }
    );

    printAuthEntries(grantRoleTx);

    await grantRoleTx.signAuthEntries({
      address: ROOT_KEYPAIR.publicKey(),
      ...basicNodeSigner(ROOT_KEYPAIR, NETWORK),
    });
    await grantRoleTx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));
    const result = await grantRoleTx.send();
    const hash = result.sendTransactionResponse?.hash;
    if (!hash) {
      throw new Error("Grant role failed: " + JSON.stringify(result, null, 2));
    }

    console.log("📤 Transaction submitted with hash:", hash);
    await confirmTransaction(hash, "Grant role");

    console.log("✅ Deployer role granted successfully");
    console.log("🔗 Deployer account:", DEPLOYER_KEYPAIR.publicKey());
  } catch (error) {
    console.error("❌ Failed to grant deployer role:", error);
    throw error;
  }
}

/**
 * Step 3: Deploy a smart account using the factory
 */
async function deploySmartAccount(factoryContractId: string): Promise<string> {
  console.log("\n" + "=".repeat(60));
  console.log("💼 STEP 3: DEPLOYING SMART ACCOUNT");
  console.log("=".repeat(60));

  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

  const factoryClient = new FactoryClient({
    contractId: factoryContractId,
    networkPassphrase: NETWORK,
    rpcUrl: RPC_URL,
    allowHttp: false,
    publicKey: TREASURY_KEYPAIR.publicKey(),
  });

  try {
    const addressTx = await factoryClient.get_deployed_address({ salt });
    const predictedAddress = addressTx.result;
    console.log("📍 Predicted smart account address:", predictedAddress);

    const constructor_args = {
      signers: [createAdminSignerFromKeypair(ADMIN_SIGNER_KEYPAIR)],
    };
    const smartAccountClient = new SmartAccountClient({
      contractId: predictedAddress,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
    });

    const deployTx = await (factoryClient as any).deploy(
      {
        caller: DEPLOYER_KEYPAIR.publicKey(),
        deployment_args: {
          wasm_hash: Buffer.from(SA_WASM_HASH, "hex"),
          salt: salt,
          // For the factory, constructor_args is Vec<Val> where each
          // entry corresponds to one argument of the contract constructor.
          // The smart-account constructor takes a single `signers` Vec, so
          // we just provide that Vec directly and let the factory bindings
          // encode it.
          // Using encoded constructor arguments ensures proper type identity
          // compatibility between smart_account and factory package XDR modules.
          constructor_args: encodeConstructorArgs(
            smartAccountClient,
            [createAdminSignerFromKeypair(ADMIN_SIGNER_KEYPAIR)]
          ),
        },
      },
      { simulate: true }
    );

    printAuthEntries(deployTx);
    await deployTx.signAuthEntries({
      address: DEPLOYER_KEYPAIR.publicKey(),
      ...basicNodeSigner(DEPLOYER_KEYPAIR, NETWORK),
    });
    await deployTx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));
    const result = await deployTx.send();
    const hash = result.sendTransactionResponse?.hash;
    if (!hash) {
      throw new Error(
        "Smart account deployment failed: " + JSON.stringify(result)
      );
    }

    console.log("📤 Transaction submitted with hash:", hash);
    await confirmTransaction(hash, "Smart account deployment");

    const contractId = deployTx.result;

    console.log("✅ Smart account deployed successfully");
    console.log("📍 Smart account contract ID:", contractId);

    return contractId;
  } catch (error) {
    console.error("❌ Smart account deployment failed:", error);
    throw error;
  }
}

/**
 * Step 4: Add additional signers to the smart account
 */
async function addSigner(smartAccountContractId: string): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("➕ STEP 4: ADDING SIGNER TO SMART ACCOUNT");
  console.log("=".repeat(60));

  const smartAccountClient = new SmartAccountClient({
    contractId: smartAccountContractId,
    networkPassphrase: NETWORK,
    rpcUrl: RPC_URL,
    allowHttp: false,
    publicKey: TREASURY_KEYPAIR.publicKey(),
  });

  try {
    const addSignerTx = await smartAccountClient.add_signer(
      {
        signer: {
          tag: "Ed25519",
          values: [
            {
              public_key: Buffer.from(DELEGATED_SIGNER_KEYPAIR.rawPublicKey()),
            },
            { tag: "Standard", values: undefined },
          ] as const,
        },
      },
      {
        simulate: true,
      }
    );

    printAuthEntries(addSignerTx);
    await authorizeWithSmartAccount(
      addSignerTx,
      smartAccountContractId,
      ADMIN_SIGNER_KEYPAIR,
      smartAccountClient
    );
    await addSignerTx.simulate();
    await addSignerTx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));
    const result = await addSignerTx.send();
    const txHash = result.sendTransactionResponse?.hash;
    if (!txHash) {
      throw new Error(
        "Add signer transaction failed: " + JSON.stringify(result)
      );
    }

    console.log("📤 Transaction submitted with hash:", txHash);
    await confirmTransaction(txHash, "Add signer");

    console.log("✅ Signer added successfully");
    console.log(
      "🔗 New signer public key:",
      DELEGATED_SIGNER_KEYPAIR.publicKey()
    );
  } catch (error) {
    console.error("❌ Failed to add signer:", error);
    throw error;
  }
}

/**
 * Step 3/4: Deploy and invoke a contract with the smart account
 */
async function deployAndInvokeContractWithSmartAccount(
  factoryContractId: string
): Promise<string> {
  console.log("\n" + "=".repeat(60));
  console.log(
    "➕ STEP 3/4 (Alternative): DEPLOYING AND INVOKING CONTRACT WITH SMART ACCOUNT"
  );
  console.log("=".repeat(60));
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const factoryClient = new FactoryClient({
    contractId: factoryContractId,
    networkPassphrase: NETWORK,
    rpcUrl: RPC_URL,
    allowHttp: false,
    publicKey: TREASURY_KEYPAIR.publicKey(),
  });
  const walletAddress = (await factoryClient.get_deployed_address({ salt }))
    .result;

  console.log("📍 Predicted smart account address:", walletAddress);
  const smartAccountClient = new SmartAccountClient({
    contractId: walletAddress,
    networkPassphrase: NETWORK,
    rpcUrl: RPC_URL,
    allowHttp: false,
    publicKey: TREASURY_KEYPAIR.publicKey(),
  });
  const addSignerArgs = {
    signer: {
      tag: "Ed25519",
      values: [
        {
          public_key: Buffer.from(DELEGATED_SIGNER_KEYPAIR.rawPublicKey()),
        },
        { tag: "Standard", values: undefined },
      ] as const,
    },
  };
  console.log("📍 Encoding signer args:", addSignerArgs);
  const addSignerVal = toFactoryScVals(
    smartAccountClient.spec.funcArgsToScVals("add_signer", addSignerArgs) as xdr.ScVal[]
  );
  console.log("📍 Encoded signer args");
  // Requires both deployer and wallet auth
  const combinedTx = await (factoryClient as any).deploy_account_and_invoke(
    {
      caller: DEPLOYER_KEYPAIR.publicKey(),
      deployment_args: {
        wasm_hash: Buffer.from(SA_WASM_HASH, "hex"),
        salt: salt,
        // Provide constructor arguments with proper XDR type identity for factory compatibility.
        constructor_args: encodeConstructorArgs(
          smartAccountClient,
          [createAdminSignerFromKeypair(ADMIN_SIGNER_KEYPAIR)]
        ),
      },
      calls: [
        // Requires wallet auth
        {
          contract_id: walletAddress,
          func: "add_signer",
          args: addSignerVal,
        },
        // Requires wallet auth
        {
          contract_id: HELLO_WORLD_CONTRACT_ID,
          func: "hello",
          args: toFactoryScVals([
            nativeToScVal(walletAddress, {
              type: "address",
            }) as xdr.ScVal,
          ]),
        },
      ],
    },
    {
      simulate: true,
    }
  );

  console.log("📍 Combined transaction simulated successfully. Signing...");
  printAuthEntries(combinedTx);
  await authorizeWithSmartAccount(
    combinedTx,
    walletAddress,
    ADMIN_SIGNER_KEYPAIR,
    smartAccountClient
  );
  await combinedTx.signAuthEntries({
    address: DEPLOYER_KEYPAIR.publicKey(),
    ...basicNodeSigner(DEPLOYER_KEYPAIR, NETWORK),
  });
  await combinedTx.simulate();
  await combinedTx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));
  const result = await combinedTx.send();
  const txHash = result.sendTransactionResponse?.hash;
  if (!txHash) {
    throw new Error("Combined transaction failed: " + JSON.stringify(result));
  }
  console.log("📤 Transaction submitted with hash:", txHash);
  await confirmTransaction(txHash, "Combined transaction");
  console.log("✅ Combined transaction completed successfully");
  return walletAddress;
}
/**
 * Step 5: Send a hello world transaction with smart account authorization
 */
async function sendHelloWorldTransactionWithSmartAccountAuth(
  smartAccountContractId: string,
  step: string
): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log(`🌍 STEP ${step}: SENDING HELLO WORLD TRANSACTION`);
  console.log("=".repeat(60));

  const smartAccountClient = new SmartAccountClient({
    contractId: smartAccountContractId,
    networkPassphrase: NETWORK,
    rpcUrl: RPC_URL,
    allowHttp: false,
    publicKey: TREASURY_KEYPAIR.publicKey(),
  });

  try {
    const helloWorldTx = await AssembledTransaction.build<string[]>({
      method: "hello",
      args: [
        nativeToScVal(smartAccountContractId, {
          type: "address",
        }),
      ],
      contractId: HELLO_WORLD_CONTRACT_ID,
      networkPassphrase: NETWORK,
      rpcUrl: RPC_URL,
      allowHttp: false,
      publicKey: TREASURY_KEYPAIR.publicKey(),
      parseResultXdr: (xdrVal: xdr.ScVal) => {
        const xdrVec = xdrVal.vec();
        if (!xdrVec) {
          throw new Error("Expected a vector");
        }
        return xdrVec
          .map((xdrItem) => xdrItem.str())
          .map((str) => str.toString());
      },
    });

    printAuthEntries(helloWorldTx);
    await authorizeWithSmartAccount(
      helloWorldTx,
      smartAccountContractId,
      DELEGATED_SIGNER_KEYPAIR,
      smartAccountClient
    );
    await helloWorldTx.simulate();
    await helloWorldTx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));
    const result = await helloWorldTx.send();
    const txHash = result.sendTransactionResponse?.hash;
    if (!txHash) {
      throw new Error(
        "Hello world transaction failed: " + JSON.stringify(result)
      );
    }

    console.log("📤 Transaction submitted with hash:", txHash);
    await confirmTransaction(txHash, "Hello world transaction");

    console.log("✅ Hello world transaction completed successfully");
  } catch (error) {
    console.error("❌ Failed to send hello world transaction:", error);
    throw error;
  }
}

/**
 * Step 6: Upgrade the smart account
 */
async function upgradeSmartAccount(
  smartAccountContractId: string
): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("➕ STEP 6: UPGRADING SMART ACCOUNT");
  console.log("=".repeat(60));

  const smartAccountClient = new SmartAccountClient({
    contractId: smartAccountContractId,
    networkPassphrase: NETWORK,
    rpcUrl: RPC_URL,
    allowHttp: false,
    publicKey: TREASURY_KEYPAIR.publicKey(),
  });

  try {
    const upgradeTx = await smartAccountClient.upgrade(
      {
        new_wasm_hash: Buffer.from(SA_WASM_HASH, "hex"),
      },
      {
        simulate: true,
      }
    );

    printAuthEntries(upgradeTx);
    await authorizeWithSmartAccount(
      upgradeTx,
      smartAccountContractId,
      ADMIN_SIGNER_KEYPAIR,
      smartAccountClient
    );
    await upgradeTx.simulate();
    await upgradeTx.sign(basicNodeSigner(TREASURY_KEYPAIR, NETWORK));
    const result = await upgradeTx.send();
    const txHash = result.sendTransactionResponse?.hash;
    if (!txHash) {
      throw new Error(
        "Upgrade smart account transaction failed: " + JSON.stringify(result)
      );
    }

    console.log("📤 Transaction submitted with hash:", txHash);
    await confirmTransaction(txHash, "Upgrade smart account");

    console.log("✅ Smart account upgraded successfully");
  } catch (error) {
    console.error("❌ Failed to upgrade smart account:", error);
    throw error;
  }
}

function createAdminSignerFromKeypair(adminSignerKeyPair: Keypair): Signer {
  return {
    tag: "Ed25519",
    values: [
      {
        public_key: Buffer.from(adminSignerKeyPair.rawPublicKey()),
      } as Ed25519Signer,
      { tag: "Admin", values: undefined } as SignerRole,
    ] as const,
  };
}

/**
 * Main example function demonstrating the complete workflow
 */
async function main() {
  console.log("🚀 STARTING SMART ACCOUNT DEPLOYMENT EXAMPLE");
  console.log("🌐 Network:", NETWORK);
  console.log("🔗 RPC URL:", RPC_URL);
  console.log("\n🔑 Generated keypairs:");
  console.log("  Admin:", ROOT_KEYPAIR.publicKey());
  console.log("  Deployer:", DEPLOYER_KEYPAIR.publicKey());
  console.log("  Admin Signer:", ADMIN_SIGNER_KEYPAIR.publicKey());
  console.log("  Delegated Signer:", DELEGATED_SIGNER_KEYPAIR.publicKey());
  console.log("  Treasury:", TREASURY_KEYPAIR.publicKey());

  try {
    const factoryContractId = await deployFactory();
    await grantDeployerRole(factoryContractId);
    const _smartAccountContractId = await deploySmartAccount(factoryContractId);
    await addSigner(_smartAccountContractId);
    const smartAccountContractId =
      await deployAndInvokeContractWithSmartAccount(factoryContractId);
    await sendHelloWorldTransactionWithSmartAccountAuth(
      smartAccountContractId,
      "5"
    );
    await upgradeSmartAccount(smartAccountContractId);
    await sendHelloWorldTransactionWithSmartAccountAuth(
      smartAccountContractId,
      "7"
    );

    console.log("\n" + "=".repeat(60));
    console.log("📋 DEPLOYMENT SUMMARY");
    console.log("=".repeat(60));
    console.log("✅ All operations completed successfully!");
    console.log("🏭 Factory Contract ID:", factoryContractId);
    console.log("💼 Smart Account Contract ID:", smartAccountContractId);
    console.log("🔑 Admin Signer:", ADMIN_SIGNER_KEYPAIR.publicKey());
    console.log("🔗 Delegated Signer:", DELEGATED_SIGNER_KEYPAIR.publicKey());
  } catch (error) {
    console.error("❌ Example failed:", error);
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log("\n🎉 Example completed successfully!");
  })
  .catch(console.error);

export { deployFactory, grantDeployerRole, deploySmartAccount };
