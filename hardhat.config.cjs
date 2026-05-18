// Load .env.local for secrets (Node 20.6+ built-in, no dotenv dependency).
// File is gitignored; never commit. Falls back to Hardhat vars if absent.
try { process.loadEnvFile(require('path').resolve(__dirname, '.env.local')); } catch (_) {}

require("@matterlabs/hardhat-zksync");

module.exports = {
  zksolc: {
    version: "1.5.15",
    settings: {
      codegen: "yul", // explicit to silence zksolc's future-hard-error warning
    },
  },
  solidity: {
    // 0.8.26 required: OZ v5.6.1 uses mcopy (EIP-5656, Cancun) inline assembly
    // in Bytes.sol. Earlier solc doesn't recognize mcopy as a builtin.
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  defaultNetwork: "abstractMainnet",
  networks: {
    abstractTestnet: {
      url: "https://api.testnet.abs.xyz",
      ethNetwork: "sepolia",
      zksync: true,
      verifyURL: "https://api-explorer-verify.testnet.abs.xyz/contract_verification",
    },
    abstractMainnet: {
      url: "https://api.mainnet.abs.xyz",
      ethNetwork: "mainnet",
      zksync: true,
      verifyURL: "https://api-explorer-verify.mainnet.abs.xyz/contract_verification",
    },
  },
};
