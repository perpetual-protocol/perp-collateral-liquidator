import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import "hardhat-contract-sizer"
import "hardhat-dependency-compiler"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import "hardhat-gas-reporter"
import { HardhatUserConfig, task } from "hardhat/config"
import "solidity-coverage"
import "./mocha-test"
import { getMnemonic, getUrl, hardhatForkConfig } from "./scripts/hardhatConfig"

enum ChainId {
    OPTIMISM_CHAIN_ID = 10,
    OPTIMISM_KOVAN_CHAIN_ID = 69,
}

enum CompanionNetwork {
    optimism = "optimism",
    optimismKovan = "optimismKovan",
}

const config: HardhatUserConfig = {
    solidity: {
        version: "0.7.6",
        settings: {
            optimizer: { enabled: true, runs: 100 },
            evmVersion: "berlin",
            // for smock to mock contracts
            outputSelection: {
                "*": {
                    "*": ["storageLayout"],
                },
            },
        },
    },
    networks: {
        hardhat: {
            allowUnlimitedContractSize: true,
            saveDeployments: true,
            ...hardhatForkConfig(),
        },
        optimismKovan: {
            url: getUrl(CompanionNetwork.optimismKovan),
            accounts: {
                mnemonic: getMnemonic(CompanionNetwork.optimismKovan),
            },
            chainId: ChainId.OPTIMISM_KOVAN_CHAIN_ID,
        },
        optimism: {
            url: getUrl(CompanionNetwork.optimism),
            accounts: {
                mnemonic: getMnemonic(CompanionNetwork.optimism),
            },
            chainId: ChainId.OPTIMISM_CHAIN_ID,
        },
    },
    namedAccounts: {
        deployer: 0, // 0 means ethers.getSigners[0]
        cleanAccount: 1,

        uniswapV3Router: {
            // TODO WIP
            [ChainId.OPTIMISM_CHAIN_ID]: "",
            [ChainId.OPTIMISM_KOVAN_CHAIN_ID]: "",
        },
    },
    dependencyCompiler: {
        // We have to compile from source since UniswapV3 doesn't provide artifacts in their npm package
        paths: [
            "@uniswap/v3-core/contracts/UniswapV3Factory.sol",
            "@uniswap/v3-core/contracts/UniswapV3Pool.sol",
            "@uniswap/v3-periphery/contracts/SwapRouter.sol",
        ],
    },
    external: {
        contracts: [
            {
                artifacts: "node_modules/@openzeppelin/contracts/build",
            },
        ],
    },
    contractSizer: {
        alphaSort: true,
        runOnCompile: true,
        disambiguatePaths: false,
    },
    gasReporter: {
        excludeContracts: ["test"],
    },
    mocha: {
        require: ["ts-node/register/files"],
        jobs: 4,
        timeout: 120000,
        color: true,
    },
}

export default config
