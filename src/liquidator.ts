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

const network = +process.env.NETWORK

export class Liquidator {
    contract: LiquidatorContract
    wallet: Wallet
    mutex: Mutex
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

        this.contract = Liquidator__factory.connect(process.env.LIQUIDATOR_CONTRACT, this.wallet)

        this.vault = Vault__factory.connect(this.metadata.core.contracts.Vault.address, this.wallet)

        this.mutex = new Mutex()

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

    async fetchMakers(): Promise<Account[]> {
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

    async fetchTraders(): Promise<Account[]> {
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
        // vault.isLiqudatable()
        // liqudiator.getMaxProfitableCollateral()
        // static call liqudiator.flashLiquidate()
        // liqudiator.flashLiquidate()

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

        await this.contract.callStatic.flashLiquidate(...args)

        const orderBook = this.perpService.createOrderBook(this.wallet)
        const clearingHouse = this.perpService.createClearingHouse(this.wallet)
        const trader = account.address

        let hasCancelOrdersError = false

        for (const baseToken of account.orderBaseTokens) {
            // NOTE: If the trader has no orders in baseToken,
            // cancelAllExcessOrders() still succeeds, but changes nothing on-chain.
            // So gas will be wasted.
            const orderIds = await orderBook.getOpenOrderIds(trader, baseToken)
            if (orderIds.length == 0) {
                continue
            }

            // simulated call
            try {
                await clearingHouse.callStatic.cancelAllExcessOrders(trader, baseToken)
            } catch (err: any) {
                hasCancelOrdersError = true

                // The structure of err might be different depending on which RPC provider we use
                const errMsg = err.message || err.reason
                // Trader has enough free collateral, and it's expected that we cannot cancel orders
                if (errMsg.includes("CH_NEXO")) {
                    this.log.jinfo({
                        event: "StopCancelAllExcessOrdersSinceFreeCollateralIsEnough",
                        params: {
                            trader,
                            baseToken,
                        },
                    })
                    return // no need to cancelAllExcessOrders() and liquidate() on other baseTokens
                } else {
                    await this.jerror({
                        event: "CallStaticCancelAllExcessOrdersError",
                        params: {
                            err,
                            trader,
                            baseToken,
                        },
                    })
                    continue // still need to cancelAllExcessOrders() on other baseTokens
                }
            }

            // actual call
            try {
                await this.cancelAllExcessOrders(this.wallet, trader, baseToken)
            } catch (err: any) {
                hasCancelOrdersError = true

                await this.jerror({
                    event: "CancelAllExcessOrdersError",
                    params: {
                        err,
                        trader,
                        baseToken,
                    },
                })
            }
        }

        if (!hasCancelOrdersError) {
            await this.simulateThenLiquidate(account)
        }
    }

    async simulateThenLiquidate(account: Account): Promise<void> {
        const clearingHouse = this.perpService.createClearingHouse(this.wallet)
        const trader = account.address

        // NOTE:
        // After applying Bad Debt Attack Protection:
        // https://github.com/perpetual-protocol/perp-lushan/pull/517
        // https://github.com/perpetual-protocol/perp-lushan/pull/526
        // Regular liquidators cannot liquidate positions with bad debts,
        // only our whitelisted backstop liquidator can.

        // NOTE: We don't use account.positionBaseTokens here since subgraph can only track taker positions.
        // When it comes to liquidate, we need to liquidate the total position (taker + maker)
        // We can also use AccountBalance.getBaseTokens()
        const baseTokens = _.uniq(account.orderBaseTokens.concat(account.positionBaseTokens))
        for (const baseToken of baseTokens) {
            // simulated call
            // use callStatic.liquidate() to get returned quote, and calculate oppositeAmountBound
            let quote: Big
            let isPartialClose: boolean
            try {
                const result = await clearingHouse.callStatic["liquidate(address,address,uint256)"](
                    trader,
                    baseToken,
                    PerpService.toWei(Big(0)),
                )
                quote = PerpService.fromWei(result.quote)
                isPartialClose = result.isPartialClose
            } catch (err: any) {
                // The structure of err might be different depending on which RPC provider we use
                const errMsg = err.message || err.reason
                // Trader has enough account value so it's expected that we cannot liquidate
                if (errMsg.includes("CH_EAV")) {
                    this.log.jinfo({
                        event: "StopLiquidateSinceAccountValueIsEnough",
                        params: {
                            trader,
                            baseToken,
                        },
                    })
                    return // no need to liquidate() on other baseTokens
                } else if (errMsg.includes("CH_PSZ")) {
                    this.log.jinfo({
                        event: "SkipLiquidateSincePositionSizeIsZero",
                        params: {
                            trader,
                            baseToken,
                        },
                    })
                    continue // still need to liquidate() on other baseTokens
                } else if (errMsg.includes("CH_CLWTISO")) {
                    // happens when subgraph has not indexed the open order yet
                    this.log.jinfo({
                        event: "SkipLiquidateSinceThereIsStillOrder",
                        params: {
                            trader,
                            baseToken,
                        },
                    })
                    return
                } else {
                    await this.jerror({
                        event: "CallStaticLiquidateError",
                        params: {
                            err,
                            trader,
                            baseToken,
                        },
                    })
                    continue // still need to liquidate() on other baseTokens
                }
            }

            // actual call
            // partial close rate is 25%
            if (isPartialClose) {
                quote = quote.div(0.25)
            }
            const positionSize = await this.perpService.getTotalPositionSize(trader, baseToken)
            // enable slippage protection for liquidation, set it to 5% for now
            const slippageProtection = Big(0.05)
            if (positionSize.gt(0)) {
                // when liquidate a long position => we will short => should at least get quote * 0.95
                quote = quote.mul(Big(1).sub(slippageProtection))
            } else {
                // when liquidate a short position => we will long => should at most spend quote * 1.05
                quote = quote.mul(Big(1).add(slippageProtection))
            }
            try {
                await this.liquidate(this.wallet, trader, baseToken, quote)
            } catch (err: any) {
                await this.jerror({
                    event: "LiquidateError",
                    params: {
                        err,
                        trader,
                        baseToken,
                    },
                })
            }
        }
    }
}
