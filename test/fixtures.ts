import { ethers, waffle } from "hardhat"
import { ClearingHouseConfig } from "../typechain/perp-curie"
import { WETH9 } from "../typechain/test"
import { UniswapV3Factory } from "../typechain/uniswap-v3-core"
import { SwapRouter as UniswapRouter } from "../typechain/uniswap-v3-periphery"

export interface Fixture {
    // liquidator: Liquidator
    uniV3Factory: UniswapV3Factory
    // uniV3Router: UniswapRouter
    // clearingHouse: TestClearingHouse | ClearingHouse
    // orderBook: OrderBook
    // accountBalance: TestAccountBalance | AccountBalance
    // marketRegistry: MarketRegistry
    // clearingHouseConfig: ClearingHouseConfig
    // exchange: TestExchange | Exchange
    // vault: Vault
    // insuranceFund: InsuranceFund
    // pool: UniswapV3Pool
    // uniFeeTier: number
    // USDC: TestERC20
    // quoteToken: QuoteToken
    // baseToken: BaseToken
    // mockedBaseAggregator: MockContract
    // baseToken2: BaseToken
    // mockedBaseAggregator2: MockContract
    // pool2: UniswapV3Pool
}

export function createFixture(): () => Promise<Fixture> {
    return async (): Promise<Fixture> => {
        // deploy UniV3 ecosystem
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as unknown as UniswapV3Factory
        const weth9Factory = await ethers.getContractFactory("WETH9")
        const weth9 = (await weth9Factory.deploy()) as WETH9
        const uniV3Router = (await (
            await ethers.getContractFactory("SwapRouter")
        ).deploy(uniV3Factory.address, weth9.address)) as unknown as UniswapRouter

        // TODO WIP
        const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
        const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
        await clearingHouseConfig.initialize()

        return {
            uniV3Factory,
            // uniV3Router,
        }
    }
}
