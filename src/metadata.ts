// TODO: this is a hack before we have proper release for multi-collateral
// import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan/core/metadata.json"
// import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"
import { ethers } from "ethers"
import mainMetadataOptimismKovan from "./optimism-kovan.json"
import mainMetadataOptimism from "./optimism.json"

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
    [mainMetadataOptimism.externalContracts.WBTC]: {
        head: {
            tokenIn: mainMetadataOptimism.externalContracts.WBTC,
            fee: "3000",
            tokenOut: mainMetadataOptimism.externalContracts.WETH,
        },
        tail: ethers.utils.solidityPack(
            ["address", "uint24", "address"],
            [mainMetadataOptimism.externalContracts.WETH, "3000", mainMetadataOptimism.externalContracts.USDC],
        ),
    },
    [mainMetadataOptimism.externalContracts.WETH]: {
        head: {
            tokenIn: mainMetadataOptimism.externalContracts.WETH,
            fee: "3000",
            tokenOut: mainMetadataOptimism.externalContracts.USDC,
        },
        tail: "0x",
    },
}

const optimismKovan = {
    [mainMetadataOptimismKovan.externalContracts.WBTC]: {
        head: {
            tokenIn: mainMetadataOptimismKovan.externalContracts.WBTC,
            fee: "3000",
            tokenOut: mainMetadataOptimismKovan.externalContracts.WETH,
        },
        tail: ethers.utils.solidityPack(
            ["address", "uint24", "address"],
            [
                mainMetadataOptimismKovan.externalContracts.WETH,
                "3000",
                mainMetadataOptimismKovan.externalContracts.USDC,
            ],
        ),
    },
    [mainMetadataOptimismKovan.externalContracts.WETH]: {
        head: {
            tokenIn: mainMetadataOptimismKovan.externalContracts.WETH,
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
