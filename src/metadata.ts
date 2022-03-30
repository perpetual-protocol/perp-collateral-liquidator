// import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"
import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan-dev1/core/metadata.json"
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
    // [mainMetadataOptimism.externalContracts.WBTC]: {
    //     head: {
    //         tokenIn: mainMetadataOptimism.externalContracts.WBTC,
    //         fee: "3000",
    //         tokenOut: mainMetadataOptimism.externalContracts.WETH,
    //     },
    //     tail: ethers.utils.solidityPack(
    //         ["address", "uint24", "address"],
    //         [mainMetadataOptimism.externalContracts.WETH, "3000", mainMetadataOptimism.externalContracts.USDC],
    //     ),
    // },
    // [mainMetadataOptimism.externalContracts.WETH]: {
    //     head: {
    //         tokenIn: mainMetadataOptimism.externalContracts.WETH,
    //         fee: "3000",
    //         tokenOut: mainMetadataOptimism.externalContracts.USDC,
    //     },
    //     tail: "0x",
    // },
}

const optimismKovan = {
    [mainMetadataOptimismKovan.externalContracts.WBTC]: {
        head: {
            tokenIn: mainMetadataOptimismKovan.externalContracts.WBTC,
            fee: "3000",
            tokenOut: mainMetadataOptimismKovan.externalContracts.USDT,
        },
        tail: ethers.utils.solidityPack(
            ["address", "uint24", "address"],
            [
                mainMetadataOptimismKovan.externalContracts.USDT,
                "3000",
                mainMetadataOptimismKovan.externalContracts.USDC,
            ],
        ),
    },
    [mainMetadataOptimismKovan.externalContracts.USDT]: {
        head: {
            tokenIn: mainMetadataOptimismKovan.externalContracts.USDT,
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
