import { hash, Keypair, Networks, rpc } from "@stellar/stellar-sdk";

export const NETWORK = Networks.TESTNET;
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const SERVER = new rpc.Server(RPC_URL);
export const SA_WASM_HASH =
  "dfe9918155ff17cf4c9b8691835c054aa638c67a1b6e6485c84b813a6a3d03ae";
export const FACTORY_WASM_HASH =
  "2236ea12e541b6cced186cf5ff8f5d5d2b064555202384aabb19983f2e96867c";

export const ADMIN_SIGNER_DERIVATION_PATH =
  "PLACEHOLDER_SIGNER_DERIVATION_PATH";
export const ADMIN_SIGNER_KEYPAIR = Keypair.fromRawEd25519Seed(
  hash(Buffer.from(ADMIN_SIGNER_DERIVATION_PATH))
);

export const DELEGATED_SIGNER_DERIVATION_PATH =
  "PLACEHOLDER_DELEGATED_SIGNER_DERIVATION_PATH";
export const DELEGATED_SIGNER_KEYPAIR = Keypair.fromRawEd25519Seed(
  hash(Buffer.from(DELEGATED_SIGNER_DERIVATION_PATH))
);

export const ROOT_DERIVATION_PATH = "PLACEHOLDER_ROOT_DERIVATION_PATH";
export const ROOT_KEYPAIR = Keypair.fromRawEd25519Seed(
  hash(Buffer.from(ROOT_DERIVATION_PATH))
);

export const DEPLOYER_DERIVATION_PATH = "PLACEHOLDER_DEPLOYER_DERIVATION_PATH";
export const DEPLOYER_KEYPAIR = Keypair.fromRawEd25519Seed(
  hash(Buffer.from(DEPLOYER_DERIVATION_PATH))
);

export const TREASURY_DERIVATION_PATH = "PLACEHOLDER_TREASURY_DERIVATION_PATH";
export const TREASURY_KEYPAIR = Keypair.fromRawEd25519Seed(
  hash(Buffer.from(TREASURY_DERIVATION_PATH))
);

export const CONSTRUCTOR_FUNC = "__constructor";

export const HELLO_WORLD_CONTRACT_ID =
  "CDDIVUUFADOLUWIKZE73O5XJFC6MMQHC7AA5YKZDJV2YDPUCO6O3MN34";
