import { Mutex } from "async-mutex"
import "dotenv/config"
import { ContractTransaction, ethers, Wallet } from "ethers"
import _ from "lodash"
import fetch from "node-fetch"
import { Liquidator as LiquidatorContract, Liquidator__factory } from "../typechain"
import { Vault, Vault__factory } from "../typechain/perp-curie"
import { IERC20Metadata__factory } from "../typechain/perp-curie/factories/IERC20Metadata__factory"
import { IERC20Metadata } from "../typechain/perp-curie/IERC20Metadata"
import { LiquidationType, Metadata } from "./metadata"
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
    pathMap: Metadata
}

class CustomError extends Error {
    params: any

    constructor(message: string, { params }) {
        super(message)
        this.params = params
    }
}

// Alchemy's current rate limit is 660 CU per second, and an eth_call takes 26 CU
// so we could have around 25 eth_calls per second.
// https://docs.alchemy.com/alchemy/documentation/rate-limits
const REQUEST_CHUNK_SIZE = 25
export class Liquidator {
    config: Config
    subgraphEndpoint: string
    contract: LiquidatorContract
    wallet: Wallet
    mutex: Mutex
    nextNonce: number
    vault: Vault
    settlementToken: IERC20Metadata
    settlementTokenDecimals: number
    pathMap: Metadata

    async setup(config: Config): Promise<void> {
        console.log({
            event: "SetupLiquidator",
            params: { config },
        })

        this.config = config

        this.subgraphEndpoint = this.config.subgraphEndPt

        this.wallet = this.config.wallet

        this.nextNonce = await this.wallet.getTransactionCount()

        this.mutex = new Mutex()

        this.contract = Liquidator__factory.connect(this.config.liquidatorContractAddr, this.wallet)

        this.vault = Vault__factory.connect(await this.contract.getVault(), this.wallet)

        this.settlementToken = IERC20Metadata__factory.connect(await this.vault.getSettlementToken(), this.wallet)

        this.settlementTokenDecimals = await this.settlementToken.decimals()

        this.pathMap = this.config.pathMap

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

            const accounts = _.uniq([...makers, ...traders])

            for (const chunkedAccounts of _.chunk(accounts, REQUEST_CHUNK_SIZE)) {
                await Promise.all(
                    chunkedAccounts.map(account => {
                        console.log({ event: "TryLiquidateAccountCollateral", params: account })
                        return this.liquidate(account)
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

    async liquidateCollateral(account: string, targetCollateralAddress: string): Promise<void> {
        const { method: pathMapMethod, params: pathMapParams } = this.pathMap[targetCollateralAddress]

        switch (pathMapMethod) {
            case LiquidationType.FlashLiquidate: {
                if (!pathMapParams) {
                    const error = new CustomError("CollateralPathSetupIncorrectly", {
                        params: { account, collateral: targetCollateralAddress },
                    })
                    throw error
                }

                const params: Parameters<typeof this.contract.callStatic.flashLiquidate> = [
                    account,
                    ethers.utils.parseUnits(this.config.maxSettlementTokenSpent, this.settlementTokenDecimals),
                    ethers.utils.parseUnits(this.config.minSettlementTokenProfit, this.settlementTokenDecimals),
                    pathMapParams.head,
                    pathMapParams.tail,
                    { gasLimit: 15_000_000 },
                ]

                try {
                    await this.contract.callStatic.flashLiquidate(...params)
                } catch (e) {
                    const error = new CustomError(`${pathMapMethod}WillFail`, {
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            reason: e.toString(),
                        },
                    })
                    throw error
                }

                try {
                    const tx = await this.contract.flashLiquidate(...params)
                    console.log({
                        event: `Send${pathMapMethod}TxSucceeded`,
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            txHash: tx.hash,
                        },
                    })

                    this.nextNonce++
                    await this.txCheck(tx)
                } catch (e) {
                    const error = new CustomError(`Send${pathMapMethod}TxFailed`, {
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            reason: e.toString(),
                        },
                    })
                    throw error
                }
                break
            }
            case LiquidationType.FlashLiquidateThroughCurve: {
                const [targetFactoryAddress, targetPoolAddress] = await this.contract.findCurveFactoryAndPoolForCoins(
                    targetCollateralAddress,
                    this.settlementToken.address,
                )

                if (targetPoolAddress === ethers.constants.AddressZero) {
                    const error = new CustomError(`NoLiquidCurvePoolFound`, {
                        params: { account, targetCollateralAddress },
                    })
                    throw error
                }

                if (targetFactoryAddress === ethers.constants.AddressZero) {
                    const error = new CustomError(`NoCurveFactoryFound`, {
                        params: { account, targetFactoryAddress },
                    })
                    throw error
                }

                const params: Parameters<typeof this.contract.callStatic.flashLiquidateThroughCurve> = [
                    {
                        trader: account,
                        crvFactory: targetFactoryAddress,
                        crvPool: targetPoolAddress,
                        uniPool: pathMapParams.uniPool,
                        maxSettlementTokenSpent: ethers.utils.parseUnits(
                            this.config.maxSettlementTokenSpent,
                            this.settlementTokenDecimals,
                        ),
                        minSettlementTokenProfit: ethers.utils.parseUnits(
                            this.config.minSettlementTokenProfit,
                            this.settlementTokenDecimals,
                        ),
                        token: targetCollateralAddress,
                    },
                    { gasLimit: 15_000_000 },
                ]

                try {
                    await this.contract.callStatic.flashLiquidateThroughCurve(...params)
                } catch (e) {
                    const error = new CustomError(`${pathMapMethod}WillFail`, {
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            reason: e.toString(),
                        },
                    })
                    throw error
                }

                try {
                    const tx = await this.contract.flashLiquidateThroughCurve(...params)
                    console.log({
                        event: `Send${pathMapMethod}TxSucceeded`,
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            txHash: tx.hash,
                        },
                    })

                    this.nextNonce++
                    await this.txCheck(tx)
                } catch (e) {
                    const error = new CustomError(`Send${pathMapMethod}TxFailed`, {
                        params: {
                            account,
                            collateral: targetCollateralAddress,
                            reason: e.toString(),
                        },
                    })
                    throw error
                }
                break
            }
            default:
                throw new Error("UnknownLiquidationType")
        }
    }

    async txCheck(tx: ContractTransaction): Promise<void> {
        try {
            await tx.wait()
            console.log({
                event: `TX Succeeded`,
                params: {
                    txHash: tx.hash,
                },
            })
        } catch (e) {
            console.error({
                event: `TX Failed`,
                params: {
                    txHash: tx.hash,
                    reason: e.toString(),
                },
            })
        }
    }

    async liquidate(account: string): Promise<void> {
        if (!(await this.vault.isLiquidatable(account))) {
            return
        }

        const targetCollateralAddress = await this.contract.getMaxProfitableCollateralFromCollaterals(
            account,
            Object.keys(this.pathMap),
        )

        if (targetCollateralAddress === ethers.constants.AddressZero) {
            console.info({ event: "NoProfitableCollateralInPathMap", params: { collateral: targetCollateralAddress } })
            return
        }

        try {
            await this.liquidateCollateral(account, targetCollateralAddress)
        } catch (e) {
            console.error({ event: e.name, params: e.params || {} })
        }
    }
}
