import { Mutex } from "async-mutex"
import "dotenv/config"
import { ContractTransaction, ethers, Wallet } from "ethers"
import _ from "lodash"
import fetch from "node-fetch"
import { Liquidator as LiquidatorContract, Liquidator__factory } from "../typechain"
import { Vault, Vault__factory } from "../typechain/perp-curie"
import { IERC20Metadata__factory } from "../typechain/perp-curie/factories/IERC20Metadata__factory"
import { IERC20Metadata } from "../typechain/perp-curie/IERC20Metadata"
import { Hop, optitmismEthereum } from "./metadata"
import { sleep } from "./utils"

interface GraphData {
    id: string
}

export type Config = {
    subgraphEndPt: string
    wallet: Wallet
    liquidatorContractAddr: string
    maxSettlementTokenSpent: string
    minSettlementTokenProfit: string
    uniPool: typeof optitmismEthereum.uniPool
    crvPool: typeof optitmismEthereum.crvPool
}

// Alchemy's current rate limit is 660 CU per second, and an eth_call takes 26 CU
// so we could have around 25 eth_calls per second.
// https://docs.alchemy.com/alchemy/documentation/rate-limits
const REQUEST_CHUNK_SIZE = 25

enum LiquidateType {
    FlashLiquidate = "FlashLiquidate",
    FlashLiquidateThroughCurve = "FlashLiquidateThroughCurve",
}

export class Liquidator {
    config: Config
    subgraphEndpoint: string
    contract: LiquidatorContract
    wallet: Wallet
    mutex: Mutex
    nextNonce: number
    vault: Vault
    settlementToken: IERC20Metadata
    settlementTokenDeciamls: number
    uniPool: typeof optitmismEthereum.uniPool
    crvPool: typeof optitmismEthereum.crvPool

    async setup(config: Config): Promise<void> {
        console.log({
            event: "SetupLiquidator",
            params: { config },
        })

        this.config = config

        this.subgraphEndpoint = this.config.subgraphEndPt

        this.uniPool = this.config.uniPool

        this.crvPool = this.config.crvPool

        this.wallet = this.config.wallet

        this.nextNonce = await this.wallet.getTransactionCount()

        this.mutex = new Mutex()

        this.contract = Liquidator__factory.connect(this.config.liquidatorContractAddr, this.wallet)

        this.vault = Vault__factory.connect(await this.contract.getVault(), this.wallet)

        this.settlementToken = IERC20Metadata__factory.connect(await this.vault.getSettlementToken(), this.wallet)

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
                    await this.settlementToken.balanceOf(this.contract.address),
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
                const results = await Promise.all([this.fetchAccounts("makers"), this.fetchAccounts("traders")])
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

    async fetchAccounts(type: "traders" | "makers"): Promise<string[]> {
        const createQueryFunc = (batchSize: number, lastID: string) => `
        {
            ${type}(first: ${batchSize}, where: {id_gt: "${lastID}"}) {
                id
            }
        }`
        const extractDataFunc = (data: any): GraphData => {
            return data.data[type]
        }
        return (await this.queryAndExtractSubgraphAll(createQueryFunc, extractDataFunc)).map(
            accountData => accountData.id,
        )
    }

    async queryAndExtractSubgraphAll(
        createQueryFunc: (batchSize: number, lastID: string) => string,
        extractDataFunc: (data: any) => any,
    ): Promise<GraphData[]> {
        let results: GraphData[] = []
        // batchSize should between 0 ~ 1000
        const batchSize = 1000
        let lastID = ""
        while (true) {
            const query = createQueryFunc(batchSize, lastID)
            const data = await this.querySubgraph(query)
            if (data.errors) {
                break
            }
            const batch = extractDataFunc(data)
            if (batch.length === 0) {
                break
            }
            results = [...results, ...batch]
            lastID = results[results.length - 1].id
        }
        return results
    }

    async querySubgraph(query: string): Promise<any> {
        const resp = await fetch(this.subgraphEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({ query }),
        })
        const data = await resp.json()
        if (data.errors) {
            console.error({
                event: "GraphQueryError",
                params: {
                    err: new Error("GraphQueryError"),
                    errors: data.errors,
                },
            })
        }
        return data
    }

    inUniPool(address: string): boolean {
        return _.has(this.uniPool, address)
    }

    inCrvPool(address: string): boolean {
        return _.has(this.crvPool, address)
    }

    async liquidateCallStatic(liquidateType: string, account: string, targetCollateralAddress: string): Promise<void> {
        switch (liquidateType) {
            case LiquidateType.FlashLiquidate:
                const path = this.uniPool[targetCollateralAddress]

                if (!path) {
                    console.warn({ event: "UnknownCollateral", params: { collateral: targetCollateralAddress } })
                    return
                }

                const args: [string, ethers.BigNumberish, ethers.BigNumberish, Hop, ethers.BytesLike] = [
                    account,
                    ethers.utils.parseUnits(this.config.maxSettlementTokenSpent, this.settlementTokenDeciamls),
                    ethers.utils.parseUnits(this.config.minSettlementTokenProfit, this.settlementTokenDeciamls),
                    path.head,
                    path.tail,
                ]

                try {
                    await this.contract.callStatic.flashLiquidate(...args)
                } catch (e) {
                    console.warn({
                        event: `${liquidateType}WillFail`,
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            reason: e.toString(),
                        },
                    })
                }
                break
            case LiquidateType.FlashLiquidateThroughCurve:
                const { crvPool, uniPool } = this.crvPool[targetCollateralAddress]

                try {
                    await this.contract.callStatic.flashLiquidateThroughCurve({
                        trader: account,
                        crvPool,
                        uniPool,
                        maxSettlementTokenSpent: ethers.utils.parseUnits(
                            this.config.maxSettlementTokenSpent,
                            this.settlementTokenDeciamls,
                        ),
                        minSettlementTokenProfit: ethers.utils.parseUnits(
                            this.config.minSettlementTokenProfit,
                            this.settlementTokenDeciamls,
                        ),
                        token: targetCollateralAddress,
                    })
                } catch (e) {
                    console.warn({
                        event: `${liquidateType}WillFail`,
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            reason: e.toString(),
                        },
                    })
                }
                break
            default:
                throw new Error("Unknown liquidate type")
        }
    }

    async liquidateSend(
        liquidateType: string,
        account: string,
        targetCollateralAddress: string,
    ): Promise<ContractTransaction> {
        switch (liquidateType) {
            case LiquidateType.FlashLiquidate:
                const path = this.uniPool[targetCollateralAddress]

                if (!path) {
                    console.warn({ event: "UnknownCollateral", params: { collateral: targetCollateralAddress } })
                    return
                }

                const args: [string, ethers.BigNumberish, ethers.BigNumberish, Hop, ethers.BytesLike] = [
                    account,
                    ethers.utils.parseUnits(this.config.maxSettlementTokenSpent, this.settlementTokenDeciamls),
                    ethers.utils.parseUnits(this.config.minSettlementTokenProfit, this.settlementTokenDeciamls),
                    path.head,
                    path.tail,
                ]
                return await this.mutex.runExclusive(async () => {
                    try {
                        const tx = await this.contract.flashLiquidate(...args)
                        console.log({
                            event: `Send${liquidateType}TxSucceeded`,
                            params: {
                                account,
                                collateral: targetCollateralAddress,
                                txHash: tx.hash,
                            },
                        })
                        this.nextNonce++
                        return tx
                    } catch (e) {
                        console.error({
                            event: `Send${liquidateType}TxFailed`,
                            params: {
                                account,
                                collateral: targetCollateralAddress,
                                reason: e.toString(),
                            },
                        })
                    }
                })
            case LiquidateType.FlashLiquidateThroughCurve:
                const { crvPool, uniPool } = this.crvPool[targetCollateralAddress]

                return await this.mutex.runExclusive(async () => {
                    try {
                        const tx = await this.contract.flashLiquidateThroughCurve({
                            trader: account,
                            crvPool,
                            uniPool,
                            maxSettlementTokenSpent: ethers.utils.parseUnits(
                                this.config.maxSettlementTokenSpent,
                                this.settlementTokenDeciamls,
                            ),
                            minSettlementTokenProfit: ethers.utils.parseUnits(
                                this.config.minSettlementTokenProfit,
                                this.settlementTokenDeciamls,
                            ),
                            token: targetCollateralAddress,
                        })
                        console.log({
                            event: `Send${liquidateType}TxSucceeded`,
                            params: {
                                account,
                                collateral: targetCollateralAddress,
                                txHash: tx.hash,
                            },
                        })
                        this.nextNonce++
                        return tx
                    } catch (e) {
                        console.error({
                            event: `Send${liquidateType}TxFailed`,
                            params: {
                                account,
                                collateral: targetCollateralAddress,
                                reason: e.toString(),
                            },
                        })
                    }
                })
            default:
                throw new Error("Unknown liquidate type")
        }
    }

    async liquidateCheck(
        liquidateType: string,
        tx: ContractTransaction,
        account: string,
        targetCollateralAddress: string,
    ): Promise<void> {
        try {
            await tx.wait()
            console.log({
                event: `${liquidateType}Succeeded`,
                params: {
                    account,
                    collateral: targetCollateralAddress,
                    txHash: tx.hash,
                },
            })
        } catch (e) {
            console.error({
                event: `${liquidateType}Failed`,
                params: {
                    account,
                    collateral: targetCollateralAddress,
                    reason: e.toString(),
                },
            })
        }
    }
    async tryLiquidate(account: string): Promise<void> {
        if (!(await this.vault.isLiquidatable(account))) {
            return
        }

        const targetCollateralAddress = await this.contract.getMaxProfitableCollateralFromCollaterals(
            account,
            _.concat(Object.keys(this.uniPool), Object.keys(this.crvPool)),
        )

        if (targetCollateralAddress === "0x0000000000000000000000000000000000000000") {
            console.info({ event: "NoProfitableCollateralInPathMap", params: { collateral: targetCollateralAddress } })
            return
        }

        if (this.inUniPool(targetCollateralAddress)) {
            await this.liquidateCallStatic(LiquidateType.FlashLiquidate, account, targetCollateralAddress)

            const tx = await this.liquidateSend(LiquidateType.FlashLiquidate, account, targetCollateralAddress)

            await this.liquidateCheck(LiquidateType.FlashLiquidate, tx, account, targetCollateralAddress)
        } else if (this.inCrvPool(targetCollateralAddress)) {
            await this.liquidateCallStatic(LiquidateType.FlashLiquidateThroughCurve, account, targetCollateralAddress)

            const tx = await this.liquidateSend(
                LiquidateType.FlashLiquidateThroughCurve,
                account,
                targetCollateralAddress,
            )

            await this.liquidateCheck(LiquidateType.FlashLiquidateThroughCurve, tx, account, targetCollateralAddress)
        }
    }
}
