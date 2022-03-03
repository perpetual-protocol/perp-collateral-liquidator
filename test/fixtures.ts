import { MockContract } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { Liquidator, TestUniswapV3Callee } from "../typechain"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    Vault,
} from "../typechain/perp-curie"
import { TestERC20, WETH9 } from "../typechain/test"
import { UniswapV3Factory, UniswapV3Pool } from "../typechain/uniswap-v3-core"
import { SwapRouter as UniswapRouter } from "../typechain/uniswap-v3-periphery"
import {
    CollateralPriceFeedFixture,
    collateralTokensFixture,
    createCollateralPriceFeedFixture,
    token0Fixture,
    tokensFixture,
} from "./shared/fixtures"

export interface Fixture {
    WETH9: WETH9

    // for creating pool determistically since we have control over the address ordering
    USDC: TestERC20
    WETH2: TestERC20
    WBTC: TestERC20

    mockedWethAggregator: MockContract
    poolWethUsdc: UniswapV3Pool
    poolWbtcWeth: UniswapV3Pool
    mockedWbtcAggregator: MockContract
    liquidator: Liquidator
    uniV3Factory: UniswapV3Factory
    uniV3Router: UniswapRouter
    uniV3Callee: TestUniswapV3Callee
    clearingHouse: ClearingHouse
    orderBook: OrderBook
    accountBalance: AccountBalance
    marketRegistry: MarketRegistry
    clearingHouseConfig: ClearingHouseConfig
    exchange: Exchange
    vault: Vault
    insuranceFund: InsuranceFund
    pool: UniswapV3Pool
    uniFeeTier: number
    quoteToken: QuoteToken
    baseToken: BaseToken
    mockedBaseAggregator: MockContract
    baseToken2: BaseToken
    mockedBaseAggregator2: MockContract
    pool2: UniswapV3Pool
}

export function createFixture(): () => Promise<Fixture> {
    return async (): Promise<Fixture> => {
        // ======================================
        // deploy common
        //
        const uniFeeTier = 10000 // 1%

        const weth9Factory = await ethers.getContractFactory("WETH9")
        const WETH9 = (await weth9Factory.deploy()) as WETH9

        const { WETH: WETH2, WBTC, USDC } = await collateralTokensFixture()

        const collateralPriceFeedFixture = await createCollateralPriceFeedFixture()
        const {
            mockedAggregator: mockedWethAggregator,
            chainlinkPriceFeed: wethChainlinkPriceFeed,
        }: CollateralPriceFeedFixture = await collateralPriceFeedFixture(await WETH2.decimals(), "100")

        const {
            mockedAggregator: mockedWbtcAggregator,
            chainlinkPriceFeed: wbtcChainlinkPriceFeed,
        }: CollateralPriceFeedFixture = await collateralPriceFeedFixture(await WBTC.decimals(), "1000")

        // TODO: initialize collateral manager using the ChainlinkPriceFeed contracts

        // ======================================
        // deploy UniV3 ecosystem
        //
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
        const uniV3Router = (await (
            await ethers.getContractFactory("SwapRouter")
        ).deploy(uniV3Factory.address, WETH9.address)) as UniswapRouter

        const uniV3CalleeFactory = await ethers.getContractFactory("TestUniswapV3Callee")
        const uniV3Callee = (await uniV3CalleeFactory.deploy()) as TestUniswapV3Callee

        const poolFactory = await ethers.getContractFactory("UniswapV3Pool")

        // deploy usdc/weth pool
        await uniV3Factory.createPool(WETH2.address, USDC.address, uniFeeTier)
        const poolWethUsdcAddr = await uniV3Factory.getPool(WETH2.address, USDC.address, uniFeeTier)
        const poolWethUsdc = poolFactory.attach(poolWethUsdcAddr) as UniswapV3Pool

        // deploy wbtc/weth pool
        await uniV3Factory.createPool(WBTC.address, WETH2.address, uniFeeTier)
        const poolWbtcWethAddr = await uniV3Factory.getPool(WBTC.address, WETH2.address, uniFeeTier)
        const poolWbtcWeth = poolFactory.attach(poolWbtcWethAddr) as UniswapV3Pool

        // ======================================
        // deploy perp v2 ecosystem
        //

        let baseToken: BaseToken, quoteToken: QuoteToken, mockedBaseAggregator: MockContract
        const { token0, mockedAggregator0, token1 } = await tokensFixture()

        // we assume (base, quote) == (token0, token1)
        baseToken = token0
        quoteToken = token1
        mockedBaseAggregator = mockedAggregator0

        const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
        const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
        await clearingHouseConfig.initialize()

        // prepare uniswap factory
        await uniV3Factory.createPool(baseToken.address, quoteToken.address, uniFeeTier)

        const marketRegistryFactory = await ethers.getContractFactory("MarketRegistry")
        const marketRegistry = (await marketRegistryFactory.deploy()) as MarketRegistry
        await marketRegistry.initialize(uniV3Factory.address, quoteToken.address)

        const orderBookFactory = await ethers.getContractFactory("OrderBook")
        const orderBook = (await orderBookFactory.deploy()) as OrderBook
        await orderBook.initialize(marketRegistry.address)

        let accountBalance
        let exchange

        const accountBalanceFactory = await ethers.getContractFactory("AccountBalance")
        accountBalance = (await accountBalanceFactory.deploy()) as AccountBalance

        const exchangeFactory = await ethers.getContractFactory("Exchange")
        exchange = (await exchangeFactory.deploy()) as Exchange

        const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
        const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
        await insuranceFund.initialize(USDC.address)

        // deploy exchange
        await exchange.initialize(marketRegistry.address, orderBook.address, clearingHouseConfig.address)
        exchange.setAccountBalance(accountBalance.address)

        await orderBook.setExchange(exchange.address)

        await accountBalance.initialize(clearingHouseConfig.address, orderBook.address)

        const vaultFactory = await ethers.getContractFactory("Vault")
        const vault = (await vaultFactory.deploy()) as Vault
        await vault.initialize(
            insuranceFund.address,
            clearingHouseConfig.address,
            accountBalance.address,
            exchange.address,
        )
        await insuranceFund.setBorrower(vault.address)
        await accountBalance.setVault(vault.address)

        // deploy a pool
        const poolAddr = await uniV3Factory.getPool(baseToken.address, quoteToken.address, uniFeeTier)
        const pool = poolFactory.attach(poolAddr) as UniswapV3Pool
        await baseToken.addWhitelist(pool.address)
        await quoteToken.addWhitelist(pool.address)

        // deploy another pool
        const _token0Fixture = await token0Fixture(quoteToken.address)
        const baseToken2 = _token0Fixture.baseToken
        const mockedBaseAggregator2 = _token0Fixture.mockedAggregator
        await uniV3Factory.createPool(baseToken2.address, quoteToken.address, uniFeeTier)
        const pool2Addr = await uniV3Factory.getPool(baseToken2.address, quoteToken.address, uniFeeTier)
        const pool2 = poolFactory.attach(pool2Addr) as UniswapV3Pool

        await baseToken2.addWhitelist(pool2.address)
        await quoteToken.addWhitelist(pool2.address)

        // deploy clearingHouse
        const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
        const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
        await clearingHouse.initialize(
            clearingHouseConfig.address,
            vault.address,
            quoteToken.address,
            uniV3Factory.address,
            exchange.address,
            accountBalance.address,
            insuranceFund.address,
        )

        await clearingHouseConfig.setSettlementTokenBalanceCap(ethers.constants.MaxUint256)
        await quoteToken.mintMaximumTo(clearingHouse.address)
        await baseToken.mintMaximumTo(clearingHouse.address)
        await baseToken2.mintMaximumTo(clearingHouse.address)
        await quoteToken.addWhitelist(clearingHouse.address)
        await baseToken.addWhitelist(clearingHouse.address)
        await baseToken2.addWhitelist(clearingHouse.address)
        await marketRegistry.setClearingHouse(clearingHouse.address)
        await orderBook.setClearingHouse(clearingHouse.address)
        await exchange.setClearingHouse(clearingHouse.address)
        await accountBalance.setClearingHouse(clearingHouse.address)
        await vault.setClearingHouse(clearingHouse.address)

        // ======================================
        // deploy liquidator
        //

        const liquidatorFactory = await ethers.getContractFactory("Liquidator")
        const liquidator = (await liquidatorFactory.deploy()) as Liquidator
        await liquidator.initialize(vault.address, uniV3Router.address)

        return {
            USDC,
            WETH9,
            WETH2,
            WBTC,
            mockedWethAggregator,
            poolWethUsdc,
            mockedWbtcAggregator,
            poolWbtcWeth,
            liquidator,
            uniV3Factory,
            uniV3Router,
            uniV3Callee,
            clearingHouse,
            orderBook,
            accountBalance,
            marketRegistry,
            clearingHouseConfig,
            exchange,
            vault,
            insuranceFund,
            pool,
            uniFeeTier,
            quoteToken,
            baseToken,
            mockedBaseAggregator,
            baseToken2,
            mockedBaseAggregator2,
            pool2,
        }
    }
}
