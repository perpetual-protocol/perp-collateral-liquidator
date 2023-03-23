import { FakeContract } from "@defi-wonderland/smock"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    FactorySidechains,
    Liquidator,
    Plain4Basic,
    Registry,
    StableSwap3Pool,
    TestUniswapV3Callee,
} from "../typechain"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    CollateralManager,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    Vault,
} from "../typechain/perp-curie"
import { TestAggregatorV3, TestERC20, WETH9 } from "../typechain/test"
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
    UST: TestERC20
    FRAX: TestERC20
    USDT: TestERC20

    mockedWethAggregator: FakeContract<TestAggregatorV3>
    poolWethUsdc: UniswapV3Pool
    poolWbtcWeth: UniswapV3Pool
    mockedWbtcAggregator: FakeContract<TestAggregatorV3>
    liquidator: Liquidator
    uniV3Factory: UniswapV3Factory
    uniV3Router: UniswapRouter
    uniV3Callee: TestUniswapV3Callee
    factorySidechains: FactorySidechains
    plain4Basic: Plain4Basic
    stableSwap3Pool: StableSwap3Pool
    curveRegistry: Registry
    clearingHouse: ClearingHouse
    orderBook: OrderBook
    accountBalance: AccountBalance
    marketRegistry: MarketRegistry
    clearingHouseConfig: ClearingHouseConfig
    exchange: Exchange
    collateralManager: CollateralManager
    vault: Vault
    insuranceFund: InsuranceFund
    pool: UniswapV3Pool
    uniFeeTier: number
    quoteToken: QuoteToken
    baseToken: BaseToken
    mockedBaseAggregator: FakeContract<TestAggregatorV3>
    baseToken2: BaseToken
    mockedBaseAggregator2: FakeContract<TestAggregatorV3>
    pool2: UniswapV3Pool
    mockedUstAggregator: FakeContract<TestAggregatorV3>
}

export function createFixture(): () => Promise<Fixture> {
    return async (): Promise<Fixture> => {
        // ======================================
        // deploy common
        //

        const [admin] = waffle.provider.getWallets()

        const uniFeeTier = 10000 // 1%

        const weth9Factory = await ethers.getContractFactory("WETH9")
        const WETH9 = (await weth9Factory.deploy()) as WETH9

        const { WETH: WETH2, WBTC, USDC, UST, FRAX, USDT } = await collateralTokensFixture()
        const usdcDecimals = await USDC.decimals()

        const collateralPriceFeedFixture = await createCollateralPriceFeedFixture()
        const {
            mockedAggregator: mockedWethAggregator,
            chainlinkPriceFeed: wethChainlinkPriceFeed,
        }: CollateralPriceFeedFixture = await collateralPriceFeedFixture(await WETH2.decimals(), "100")

        const {
            mockedAggregator: mockedWbtcAggregator,
            chainlinkPriceFeed: wbtcChainlinkPriceFeed,
        }: CollateralPriceFeedFixture = await collateralPriceFeedFixture(await WBTC.decimals(), "1000")

        const {
            mockedAggregator: mockedUstAggregator,
            chainlinkPriceFeed: ustChainlinkPriceFeed,
        }: CollateralPriceFeedFixture = await collateralPriceFeedFixture(await UST.decimals(), "1")

        // ======================================
        // deploy Curve ecosystem
        //

        const registryAddressProviderFactory = await ethers.getContractFactory("RegistryAddressProvider")
        const registryAddressProvider = await registryAddressProviderFactory.deploy(admin.address)

        const curveRegistryFactory = await ethers.getContractFactory("Registry")
        const curveRegistry = (await curveRegistryFactory.deploy(registryAddressProvider.address)) as Registry

        const factorySidechainsFactory = await ethers.getContractFactory("FactorySidechains")
        const factorySidechains = (await factorySidechainsFactory.deploy(
            "0x0000000000000000000000000000000000000001",
        )) as FactorySidechains

        const contractFactory = await ethers.getContractFactory("StableSwap")
        const impl1 = await contractFactory.deploy()
        const impl2 = await contractFactory.deploy()
        const impl3 = await contractFactory.deploy()
        const impl4 = await contractFactory.deploy()

        await factorySidechains.set_plain_implementations(4, [
            impl1.address,
            impl2.address,
            impl3.address,
            impl4.address,
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000",
        ])

        await factorySidechains["deploy_plain_pool(string,string,address[4],uint256,uint256)"](
            "4pool",
            "4pool",
            [USDC.address, UST.address, FRAX.address, USDT.address],
            200,
            4000000,
        )

        const poolUstUsdcAddr = await factorySidechains["find_pool_for_coins(address,address)"](
            UST.address,
            USDC.address,
        )
        const plain4Basic = (await ethers.getContractAt("Plain4Basic", poolUstUsdcAddr)) as Plain4Basic

        const stableSwap3PoolFactory = await ethers.getContractFactory("StableSwap3Pool")
        const stableSwap3Pool = (await stableSwap3PoolFactory.deploy(
            [FRAX.address, USDC.address, USDT.address],
            1000,
            4000000,
            5000000000,
            "3pool",
            "3pool",
        )) as StableSwap3Pool

        await curveRegistry.add_pool_without_underlying(
            stableSwap3Pool.address,
            3,
            stableSwap3Pool.address,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            394770,
            0,
            "3pool",
        )

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

        let baseToken: BaseToken, quoteToken: QuoteToken, mockedBaseAggregator: FakeContract<TestAggregatorV3>
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
        await insuranceFund.setVault(vault.address)
        await accountBalance.setVault(vault.address)

        // deploy collateral manager
        const collateralManagerFactory = await ethers.getContractFactory("CollateralManager")
        const collateralManager = (await collateralManagerFactory.deploy()) as CollateralManager
        await collateralManager.initialize(
            clearingHouseConfig.address,
            vault.address,
            5, // maxCollateralTokensPerAccount
            "750000", // debtNonSettlementTokenValueRatio
            "500000", // liquidationRatio
            "2000", // maintenanceMarginRatioBuffer
            "30000", // clInsuranceFundFeeRatio
            parseUnits("10000", usdcDecimals), // debtThreshold
            parseUnits("50", usdcDecimals), // collateralValueDust
        )
        await collateralManager.addCollateral(WETH2.address, {
            priceFeed: wethChainlinkPriceFeed.address,
            collateralRatio: (0.8e6).toString(),
            discountRatio: (0.1e6).toString(),
            depositCap: parseEther("1000"),
        })
        await collateralManager.addCollateral(WBTC.address, {
            priceFeed: wbtcChainlinkPriceFeed.address,
            collateralRatio: (0.8e6).toString(),
            discountRatio: (0.1e6).toString(),
            depositCap: parseUnits("1000", await WBTC.decimals()),
        })
        await collateralManager.addCollateral(UST.address, {
            priceFeed: ustChainlinkPriceFeed.address,
            collateralRatio: (0.8e6).toString(),
            discountRatio: (0.1e6).toString(),
            depositCap: parseUnits("1000000", await UST.decimals()),
        })

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
        await vault.setCollateralManager(collateralManager.address)

        // ======================================
        // deploy liquidator
        //

        const liquidatorFactory = await ethers.getContractFactory("Liquidator")
        const liquidator = (await liquidatorFactory.deploy(vault.address, uniV3Router.address, uniV3Factory.address, [
            factorySidechains.address,
            curveRegistry.address,
            // "0x2db0E83599a91b508Ac268a6197b8B14F5e72840", // OP sidechain factory
        ])) as Liquidator

        return {
            USDC,
            WETH9,
            WETH2,
            WBTC,
            UST,
            FRAX,
            USDT,
            mockedWethAggregator,
            poolWethUsdc,
            mockedWbtcAggregator,
            poolWbtcWeth,
            liquidator,
            uniV3Factory,
            uniV3Router,
            uniV3Callee,
            factorySidechains,
            plain4Basic,
            stableSwap3Pool,
            curveRegistry,
            clearingHouse,
            orderBook,
            accountBalance,
            marketRegistry,
            clearingHouseConfig,
            exchange,
            collateralManager,
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
            mockedUstAggregator,
        }
    }
}
