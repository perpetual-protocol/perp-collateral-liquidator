import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan/core/metadata.json"
import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"
import { ethers } from "ethers"

export type Hop = {
    tokenIn: string
    fee: ethers.BigNumberish
    tokenOut: string
}

export type UniWay = {
    method: LiquidationType.FlashLiquidate
    params: {
        head: Hop
        tail: string
    }
}

export type CrvWay = {
    method: LiquidationType.FlashLiquidateThroughCurve
    params: {
        uniPool: string
    }
}

export const chain = {
    optitmismEthereum: 10,
    optitmismKovan: 69,
}

export enum LiquidationType {
    FlashLiquidate = "FlashLiquidate",
    FlashLiquidateThroughCurve = "FlashLiquidateThroughCurve",
}

export type Metadata = {
    [key: string]: UniWay | CrvWay
}

export const optitmismEthereum: Metadata = {
    [mainMetadataOptimism.externalContracts.WETH9]: {
        method: LiquidationType.FlashLiquidate,
        params: {
            head: {
                tokenIn: mainMetadataOptimism.externalContracts.WETH9,
                fee: "3000",
                tokenOut: mainMetadataOptimism.externalContracts.USDC,
            },
            tail: "0x",
        },
    },
}

const optimismKovan: Metadata = {
    [mainMetadataOptimismKovan.externalContracts.TestWBTC]: {
        method: LiquidationType.FlashLiquidate,
        params: {
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
    },
    [mainMetadataOptimismKovan.externalContracts.TestUSDT]: {
        method: LiquidationType.FlashLiquidate,
        params: {
            head: {
                tokenIn: mainMetadataOptimismKovan.externalContracts.TestUSDT,
                fee: "3000",
                tokenOut: mainMetadataOptimismKovan.externalContracts.USDC,
            },
            tail: "0x",
        },
    },
    // [mainMetadataOptimismKovan.externalContracts.UST]: {
    //     method: LiquidationType.FlashLiquidateThroughCurve,
    //     params: {
    //         uniPool: "0x0000000000000000000000000000000000000000",
    //     }
    // },
}

export default {
    [chain.optitmismEthereum]: optitmismEthereum,
    [chain.optitmismKovan]: optimismKovan,
}
