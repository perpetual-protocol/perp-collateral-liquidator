import mainMetadataOptimismGoerli from "@perp/curie-deployments/optimism-goerli/core/metadata.json"
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
    optimismGoerli: 420,
}

export enum LiquidationType {
    FlashLiquidate = "FlashLiquidate",
    FlashLiquidateThroughCurve = "FlashLiquidateThroughCurve",
}

export type Metadata = {
    [key: string]: UniWay | CrvWay
}

// NOTE: check below optimismGoerli variable to see how to configure a swap route
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

const optimismGoerli: Metadata = {
    // NOTE: swap from Uniswap's pool with multiple hops (BTC -> USDT -> USDC)
    [mainMetadataOptimismGoerli.externalContracts.TestWBTC]: {
        method: LiquidationType.FlashLiquidate,
        params: {
            head: {
                tokenIn: mainMetadataOptimismGoerli.externalContracts.TestWBTC,
                fee: "3000",
                tokenOut: mainMetadataOptimismGoerli.externalContracts.TestUSDT,
            },
            tail: ethers.utils.solidityPack(
                ["address", "uint24", "address"],
                [
                    mainMetadataOptimismGoerli.externalContracts.TestUSDT,
                    "3000",
                    mainMetadataOptimismGoerli.externalContracts.USDC,
                ],
            ),
        },
    },
    // NOTE: swap from Uniswap's pool with single hop (USDT -> USDC)
    [mainMetadataOptimismGoerli.externalContracts.TestUSDT]: {
        method: LiquidationType.FlashLiquidate,
        params: {
            head: {
                tokenIn: mainMetadataOptimismGoerli.externalContracts.TestUSDT,
                fee: "3000",
                tokenOut: mainMetadataOptimismGoerli.externalContracts.USDC,
            },
            tail: "0x",
        },
    },
    // NOTE: flash loan from Uniswap's pool to borrow out USDC then swap the non-USD collateral back to USDC from curve pool
    // [mainMetadataOptimismGoerli.externalContracts.UST]: {
    //     method: LiquidationType.FlashLiquidateThroughCurve,
    //     params: {
    //         uniPool: "0x0000000000000000000000000000000000000000",
    //     }
    // },
}

export default {
    [chain.optitmismEthereum]: optitmismEthereum,
    [chain.optimismGoerli]: optimismGoerli,
}
