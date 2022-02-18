import WETH9 from "@uniswap/v3-periphery/test/contracts/WETH9.json"
import { Signer } from "ethers"
import { ethers, waffle } from "hardhat"
import {
    IWETH9,
    SwapRouter as UniswapRouter,
    UniswapV3Factory,
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Factory,
    UniswapV3Pool,
    Vault,
} from "../typechain"

export interface Fixture {
    // liquidator: Liquidator
    uniV3Factory: UniswapV3Factory
    uniV3Router: UniswapRouter
    clearingHouse: TestClearingHouse | ClearingHouse
    orderBook: OrderBook
    accountBalance: TestAccountBalance | AccountBalance
    marketRegistry: MarketRegistry
    clearingHouseConfig: ClearingHouseConfig
    exchange: TestExchange | Exchange
    vault: Vault
    insuranceFund: InsuranceFund
    pool: UniswapV3Pool
    uniFeeTier: number
    USDC: TestERC20
    quoteToken: QuoteToken
    baseToken: BaseToken
    mockedBaseAggregator: MockContract
    baseToken2: BaseToken
    mockedBaseAggregator2: MockContract
    pool2: UniswapV3Pool
}

export function createFixture(): () => Promise<Fixture> {
    return async (): Promise<Fixture> => {
        const [admin] = waffle.provider.getWallets()

        // deploy UniV3 ecosystem
        const weth9 = (await waffle.deployContract(admin as Signer, {
            bytecode: WETH9.bytecode,
            abi: WETH9.abi,
        })) as unknown as IWETH9
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as unknown as UniswapV3Factory
        const uniV3Router = (await (
            await ethers.getContractFactory("SwapRouter")
        ).deploy(uniV3Factory.address, weth9.address)) as unknown as UniswapRouter

        return {
            uniV3Factory,
            uniV3Router,
        }
    }
}
