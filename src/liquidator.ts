import { Mutex } from "async-mutex"
import { Big } from "big.js"
import "dotenv/config"
import { ethers, Wallet } from "ethers"
import _ from "lodash"
import { Liquidator as LiquidatorContract, Liquidator__factory } from "../typechain"
import { Vault, Vault__factory } from "../typechain/perp-curie"
import { IERC20Metadata__factory } from "../typechain/perp-curie/factories/IERC20Metadata__factory"
import { IERC20Metadata } from "../typechain/perp-curie/IERC20Metadata"
import config from "./config"
import allMetadata, { Hop } from "./metadata"
import { sleep } from "./utils"

export interface LiquidatorSecrets {
    LIQUIDATOR_PK: string
}

// Alchemy's current rate limit is 660 CU per second, and an eth_call takes 26 CU
// so we could have around 25 eth_calls per second.
// https://docs.alchemy.com/alchemy/documentation/rate-limits
const REQUEST_CHUNK_SIZE = 25

export class Liquidator {
    contract: LiquidatorContract
    wallet: Wallet
    mutex: Mutex
    nextNonce: number
    vault: Vault
    settlementToken: IERC20Metadata
    settlementTokenDeciamls: number
    metadata: typeof allMetadata[10]

    async setup(): Promise<void> {
        console.log({
            event: "SetupLiquidator",
        })

        this.metadata = allMetadata[+process.env.NETWORK]

        this.wallet = new Wallet(process.env.LIQUIDATOR_KEY).connect(
            new ethers.providers.StaticJsonRpcProvider(process.env.RPC_URL),
        )

        this.nextNonce = await this.wallet.getTransactionCount()
        this.mutex = new Mutex()

        this.contract = Liquidator__factory.connect(process.env.LIQUIDATOR_CONTRACT, this.wallet)

        this.vault = Vault__factory.connect(this.metadata.core.contracts.Vault.address, this.wallet)

        this.settlementToken = IERC20Metadata__factory.connect(this.metadata.core.externalContracts.USDC, this.wallet)
        this.settlementTokenDeciamls = await this.settlementToken.decimals()

        console.log({
            event: "LiquidatorWalletFetched",
            params: {
                address: this.wallet.address,
                ethBalance: ethers.utils.formatEther(await this.wallet.getBalance()),
            },
        })

        console.log({
            event: "LiquidatorContractFetched",
            params: {
                address: this.contract.address,
                usdcBalance: ethers.utils.formatUnits(
                    await this.settlementToken.balanceOf(this.wallet.address),
                    await this.settlementToken.decimals(),
                ),
            },
        })
    }

    async start(): Promise<void> {
        let makers: string[]
        let traders: string[]
        while (true) {
            try {
                // TODO: WIP
                const results = await Promise.all([this.fetchMakers(), this.fetchTraders()])
                makers = results[0]
                traders = results[1]
            } catch (err: any) {
                console.error({
                    event: "FetchMakerTraderError",
                    params: {
                        err,
                    },
                })

                // retry after 3 seconds
                await sleep(3000)
                continue
            }

            const accounts = [...makers, ...traders]

            for (const chunkedAccounts of _.chunk(accounts, REQUEST_CHUNK_SIZE)) {
                await Promise.all(
                    chunkedAccounts.map(account => {
                        console.log({ event: "TryLiquidateAccountCollateral", params: account })
                        return this.tryLiquidate(account)
                    }),
                )
            }
        }
    }

    async fetchMakers(): Promise<string[]> {
        const createQueryFunc = (batchSize: number, lastID: string) => `
        {
            makers(first: ${batchSize}, where: {id_gt: "${lastID}"}) {
                id
                openOrders(where: {liquidity_gt: 0}) {
                    baseToken
                }
            }
        }`
        const extractDataFunc = (data: any) => {
            return data.data.makers.flatMap((maker: any) => {
                const orderBaseTokens = _.uniq(maker.openOrders.map((openOrder: any) => openOrder.baseToken))
                if (orderBaseTokens.length > 0) {
                    return [
                        {
                            address: maker.id,
                            orderBaseTokens,
                        },
                    ]
                } else {
                    return []
                }
            })
        }
        return await this.graphService.queryAll<any>(createQueryFunc, extractDataFunc)
    }

    async fetchTraders(): Promise<string[]> {
        const createQueryFunc = (batchSize: number, lastID: string) => `
        {
            traders(first: ${batchSize}, where: {id_gt: "${lastID}"}) {
                id
                positions(where: {positionSize_not: 0}) {
                    baseToken
                }
            }
        }`
        const extractDataFunc = (data: any) => {
            return data.data.traders.flatMap((trader: any) => {
                const positionBaseTokens = _.uniq(trader.positions.map((position: any) => position.baseToken))
                if (positionBaseTokens.length > 0) {
                    return [
                        {
                            address: trader.id,
                            positionBaseTokens,
                        },
                    ]
                } else {
                    return []
                }
            })
        }
        return await this.graphService.queryAll<any>(createQueryFunc, extractDataFunc)
    }

    async tryLiquidate(account: string): Promise<void> {
        if (!(await this.vault.isLiquidatable(account))) {
            return
        }

        const targetCollateralAddress = await this.contract.getMaxProfitableCollateral(account)

        const path = this.metadata.pathMap[targetCollateralAddress]

        if (!path) {
            console.warn({ event: "UnknownCollateral", params: { collateral: targetCollateralAddress } })
            return
        }

        const args: [string, ethers.BigNumberish, ethers.BigNumberish, Hop, ethers.BytesLike] = [
            account,
            ethers.utils.formatUnits(config.maxSettlementTokenSpent, this.settlementTokenDeciamls),
            ethers.utils.formatUnits(config.minSettlementTokenProfit, this.settlementTokenDeciamls),
            path[0],
            path[1] || "0x",
        ]

        try {
            await this.contract.callStatic.flashLiquidate(...args)
        } catch (e) {
            console.warn("FlashLiquidateWillFail", {
                account,
                collateral: targetCollateralAddress,
                reason: e.toString(),
            })
            return
        }

        const tx = await this.mutex.runExclusive(async () => {
            try {
                const tx = await this.contract.flashLiquidate(...args)
                console.log("SendFlashLiquidateTxSucceeded", {
                    account,
                    collateral: targetCollateralAddress,
                    txHash: tx.hash,
                })
                this.nextNonce++
                return tx
            } catch (e) {
                console.error("SendFlashLiquidateTxFailed", {
                    account,
                    collateral: targetCollateralAddress,
                    reason: e.toString(),
                })
            }
        })

        try {
            await tx.wait()
            console.log("FlashLiquidateSucceeded", {
                account,
                collateral: targetCollateralAddress,
                txHash: tx.hash,
            })
        } catch (e) {
            console.error("FlashLiquidateFailed", {
                account,
                collateral: targetCollateralAddress,
                reason: e.toString(),
            })
        }
    }
}
