import { Mutex } from "async-mutex"
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

interface GraphData {
    id: string
}

// Alchemy's current rate limit is 660 CU per second, and an eth_call takes 26 CU
// so we could have around 25 eth_calls per second.
// https://docs.alchemy.com/alchemy/documentation/rate-limits
const REQUEST_CHUNK_SIZE = 25

export class Liquidator {
    subgraphEndpoint: string
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

        this.subgraphEndpoint = process.env.SUBGRAPH_ENDPT

        this.metadata = allMetadata[+process.env.NETWORK]

        this.wallet = new Wallet(process.env.LIQUIDATOR_KEY).connect(
            new ethers.providers.StaticJsonRpcProvider(process.env.WEB3_ENDPT),
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
