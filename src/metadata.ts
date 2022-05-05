// import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"
import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan/core/metadata.json"
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
    uniPool: {
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
    },
    crvPool: {
        // [mainMetadataOptimism.externalContracts.UST]: {
        //     uniPool: "0x0000000000000000000000000000000000000000",
        //     crvPool: "0x0000000000000000000000000000000000000000",
        // },
    },
}

const optimismKovan = {
    uniPool: {
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
    },
    crvPool: {
        // [mainMetadataOptimismKovan.externalContracts.UST]: {
        //     uniPool: "0x0000000000000000000000000000000000000000",
        //     crvPool: "0x0000000000000000000000000000000000000000",
        // },
    },
}

export default {
    [chain.optitmismEthereum]: optitmismEthereum,
    [chain.optitmismKovan]: optimismKovan,
}
