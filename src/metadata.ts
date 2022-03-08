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

const optitmismEthereum = {
    core: mainMetadataOptimism,
    pathMap: {
        [mainMetadataOptimism.externalContracts.WBTC]: [
            {
                tokenIn: mainMetadataOptimism.externalContracts.WBTC,
                fee: "3000",
                tokenOut: mainMetadataOptimism.externalContracts.WETH,
            },
            ethers.utils.solidityPack(
                ["address", "uint24", "address"],
                [mainMetadataOptimism.externalContracts.WETH, "3000", mainMetadataOptimism.externalContracts.USDC],
            ),
        ],
        [mainMetadataOptimism.externalContracts.WETH]: [
            {
                tokenIn: mainMetadataOptimism.externalContracts.WETH,
                fee: "3000",
                tokenOut: mainMetadataOptimism.externalContracts.USDC,
            },
        ],
    },
}

const optimismKovan = {
    core: mainMetadataOptimismKovan,
    pathMap: {
        [mainMetadataOptimismKovan.externalContracts.WBTC]: [
            [
                mainMetadataOptimismKovan.externalContracts.WBTC,
                "3000",
                mainMetadataOptimismKovan.externalContracts.WETH,
            ],
            [
                mainMetadataOptimismKovan.externalContracts.WETH,
                "3000",
                mainMetadataOptimismKovan.externalContracts.USDC,
            ],
        ],
        [mainMetadataOptimismKovan.externalContracts.WETH]: [
            [
                mainMetadataOptimismKovan.externalContracts.WETH,
                "3000",
                mainMetadataOptimismKovan.externalContracts.USDC,
            ],
        ],
    },
}

export default {
    [chain.optitmismEthereum]: optitmismEthereum,
    [chain.optitmismKovan]: optimismKovan,
}
