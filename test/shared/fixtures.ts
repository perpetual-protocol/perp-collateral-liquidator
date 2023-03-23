import { FakeContract, smock } from "@defi-wonderland/smock"
import { parseUnits } from "ethers/lib/utils"
import { ethers } from "hardhat"
import { BaseToken, QuoteToken, VirtualToken } from "../../typechain/perp-curie"
import { ChainlinkPriceFeed } from "../../typechain/perp-oracle"
import { TestAggregatorV3, TestERC20 } from "../../typechain/test"
import { UniswapV3Factory, UniswapV3Pool } from "../../typechain/uniswap-v3-core"
import { isAscendingTokenOrder } from "./utilities"

interface TokensFixture {
    token0: BaseToken
    token1: QuoteToken
    mockedAggregator0: FakeContract<TestAggregatorV3>
    mockedAggregator1: FakeContract<TestAggregatorV3>
}

interface CollateralTokensFixture {
    // address in ascending order
    USDT: TestERC20
    FRAX: TestERC20
    UST: TestERC20
    WBTC: TestERC20
    WETH: TestERC20
    USDC: TestERC20
}
interface PoolFixture {
    factory: UniswapV3Factory
    pool: UniswapV3Pool
    baseToken: BaseToken
    quoteToken: QuoteToken
}

interface BaseTokenFixture {
    baseToken: BaseToken
    mockedAggregator: FakeContract<TestAggregatorV3>
}

export interface CollateralPriceFeedFixture {
    mockedAggregator: FakeContract<TestAggregatorV3>
    chainlinkPriceFeed: ChainlinkPriceFeed
}

export function createQuoteTokenFixture(name: string, symbol: string): () => Promise<QuoteToken> {
    return async (): Promise<QuoteToken> => {
        const quoteTokenFactory = await ethers.getContractFactory("QuoteToken")
        const quoteToken = (await quoteTokenFactory.deploy()) as QuoteToken
        await quoteToken.initialize(name, symbol)
        return quoteToken
    }
}

export function createBaseTokenFixture(name: string, symbol: string): () => Promise<BaseTokenFixture> {
    return async (): Promise<BaseTokenFixture> => {
        const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
        const aggregator = await aggregatorFactory.deploy()
        const mockedAggregator = (await smock.fake(aggregator)) as FakeContract<TestAggregatorV3>

        mockedAggregator.decimals.returns(async () => {
            return 6
        })

        const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed")
        const chainlinkPriceFeed = (await chainlinkPriceFeedFactory.deploy(
            mockedAggregator.address,
        )) as ChainlinkPriceFeed

        const baseTokenFactory = await ethers.getContractFactory("BaseToken")
        const baseToken = (await baseTokenFactory.deploy()) as BaseToken
        await baseToken.initialize(name, symbol, chainlinkPriceFeed.address)

        return { baseToken, mockedAggregator }
    }
}

export async function createCollateralTokenFixture(): Promise<TestERC20> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const token = (await tokenFactory.deploy()) as TestERC20
    return token
}

export function createCollateralPriceFeedFixture(): (number, string) => Promise<CollateralPriceFeedFixture> {
    return async (tokenDecimal: number, defaultPrice: string): Promise<CollateralPriceFeedFixture> => {
        const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
        const aggregator = await aggregatorFactory.deploy()
        const mockedAggregator = (await smock.fake(aggregator)) as FakeContract<TestAggregatorV3>

        mockedAggregator.decimals.returns(async () => {
            return tokenDecimal
        })

        mockedAggregator.latestRoundData.returns(async () => {
            return [0, parseUnits(defaultPrice, tokenDecimal), 0, 0, 0]
        })

        const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed")
        const chainlinkPriceFeed = (await chainlinkPriceFeedFactory.deploy(
            mockedAggregator.address,
        )) as ChainlinkPriceFeed

        return { chainlinkPriceFeed, mockedAggregator }
    }
}

export async function uniswapV3FactoryFixture(): Promise<UniswapV3Factory> {
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    return (await factoryFactory.deploy()) as UniswapV3Factory
}

// assume isAscendingTokensOrder() == true/ token0 < token1
export async function tokensFixture(): Promise<TokensFixture> {
    const { baseToken: randomToken0, mockedAggregator: randomMockedAggregator0 } = await createBaseTokenFixture(
        "RandomTestToken0",
        "randomToken0",
    )()
    const { baseToken: randomToken1, mockedAggregator: randomMockedAggregator1 } = await createBaseTokenFixture(
        "RandomTestToken1",
        "randomToken1",
    )()

    let token0: BaseToken
    let token1: QuoteToken
    let mockedAggregator0: FakeContract<TestAggregatorV3>
    let mockedAggregator1: FakeContract<TestAggregatorV3>
    if (isAscendingTokenOrder(randomToken0.address, randomToken1.address)) {
        token0 = randomToken0
        mockedAggregator0 = randomMockedAggregator0
        token1 = randomToken1 as VirtualToken as QuoteToken
        mockedAggregator1 = randomMockedAggregator1
    } else {
        token0 = randomToken1
        mockedAggregator0 = randomMockedAggregator1
        token1 = randomToken0 as VirtualToken as QuoteToken
        mockedAggregator1 = randomMockedAggregator0
    }
    return {
        token0,
        mockedAggregator0,
        token1,
        mockedAggregator1,
    }
}

export async function collateralTokensFixture(): Promise<CollateralTokensFixture> {
    const token0 = await createCollateralTokenFixture()
    const token1 = await createCollateralTokenFixture()
    const token2 = await createCollateralTokenFixture()
    const token3 = await createCollateralTokenFixture()
    const token4 = await createCollateralTokenFixture()
    const token5 = await createCollateralTokenFixture()

    // usdc > eth > btc
    // to let us create these pools: eth/usdc, and btc/eth
    const orderedToken = [token0, token1, token2, token3, token4, token5].sort((tokenA, tokenB) =>
        tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1,
    )

    await orderedToken[0].__TestERC20_init("WBTC", "WBTC", "8")
    await orderedToken[1].__TestERC20_init("WETH", "WETH", "18")
    await orderedToken[2].__TestERC20_init("USDC", "USDC", "6")
    await orderedToken[3].__TestERC20_init("UST", "UST", "6")
    await orderedToken[4].__TestERC20_init("FRAX", "FRAX", "18")
    await orderedToken[5].__TestERC20_init("USDT", "USDT", "6")

    return {
        WBTC: orderedToken[0],
        WETH: orderedToken[1],
        USDC: orderedToken[2],
        UST: orderedToken[3],
        FRAX: orderedToken[4],
        USDT: orderedToken[5],
    }
}

export async function token0Fixture(token1Addr: string): Promise<BaseTokenFixture> {
    let token0Fixture: BaseTokenFixture
    while (!token0Fixture || !isAscendingTokenOrder(token0Fixture.baseToken.address, token1Addr)) {
        token0Fixture = await createBaseTokenFixture("RandomTestToken0", "randomToken0")()
    }
    return token0Fixture
}

export async function base0Quote1PoolFixture(): Promise<PoolFixture> {
    const { token0, token1 } = await tokensFixture()
    const factory = await uniswapV3FactoryFixture()

    const tx = await factory.createPool(token0.address, token1.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddress) as UniswapV3Pool

    return { factory, pool, baseToken: token0, quoteToken: token1 }
}
