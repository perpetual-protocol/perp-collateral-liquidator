import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan/core/metadata.json"
import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"
import { ethers } from "ethers"

export type Hop = {
    tokenIn: string
    fee: ethers.BigNumberish
    tokenOut: string
}

export const chain = {
    optitmismEthereum: 10,
    optitmismKovan: 69,
}

export const optitmismEthereum = {
    [mainMetadataOptimism.externalContracts.WETH9]: {
        head: {
            tokenIn: mainMetadataOptimism.externalContracts.WETH9,
            fee: "3000",
            tokenOut: mainMetadataOptimism.externalContracts.USDC,
        },
        tail: "0x",
    },
}

const optimismKovan = {
    [mainMetadataOptimismKovan.externalContracts.TestWBTC]: {
        head: {
            tokenIn: mainMetadataOptimismKovan.externalContracts.TestWBTC,
            fee: "3000",
            tokenOut: mainMetadataOptimismKovan.externalContracts.TestUSDT,
        },
        tail: ethers.utils.solidityPack(
            ["address", "uint24", "address"],
            [
                mainMetadataOptimismKovan.externalContracts.TestUSDT,
                "3000",
                mainMetadataOptimismKovan.externalContracts.USDC,
            ],
        ),
    },
    [mainMetadataOptimismKovan.externalContracts.TestUSDT]: {
        head: {
            tokenIn: mainMetadataOptimismKovan.externalContracts.TestUSDT,
            fee: "3000",
            tokenOut: mainMetadataOptimismKovan.externalContracts.USDC,
        },
        tail: "0x",
    },
}

export default {
    [chain.optitmismEthereum]: optitmismEthereum,
    [chain.optitmismKovan]: optimismKovan,
}
