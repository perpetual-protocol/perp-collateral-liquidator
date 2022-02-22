import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import fs from "fs"
import "hardhat-contract-sizer"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import "hardhat-gas-reporter"
import { HardhatUserConfig } from "hardhat/config"
import path from "path"
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
    // so we can load the contract artifacts in tests
    external: {
        contracts: [
            {
                artifacts: "node_modules/@openzeppelin/contracts/build",
            },
            {
                artifacts: "node_modules/@uniswap/v3-core/artifacts/contracts",
            },
            {
                artifacts: "node_modules/@uniswap/v3-periphery/artifacts/contracts",
            },
            {
                artifacts: "node_modules/@perp/curie-contract/artifacts/contracts",
            },
            {
                artifacts: "test/contracts",
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

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
    const files = fs.readdirSync(dirPath)

    arrayOfFiles = arrayOfFiles || []

    files.forEach(function (file) {
        if (fs.statSync(dirPath + "/" + file).isDirectory()) {
            arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles)
        } else {
            arrayOfFiles.push(path.join(dirPath, "/", file))
        }
    })

    return arrayOfFiles
}

export default config
