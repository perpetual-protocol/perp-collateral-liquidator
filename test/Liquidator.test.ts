import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Liquidator } from "../typechain"
import { BaseToken, ClearingHouse, Exchange, MarketRegistry, Vault } from "../typechain/perp-curie"
import { TestERC20, WETH9 } from "../typechain/test"
import { UniswapV3Pool } from "../typechain/uniswap-v3-core"
import { createFixture } from "./fixtures"
import { deposit } from "./helper/token"
import { encodePriceSqrt, syncIndexToMarketPrice } from "./shared/utilities"

describe("Liquidator", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()

    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])

    let vault: Vault
    let clearingHouse: ClearingHouse
    let exchange: Exchange
    let pool: UniswapV3Pool
    let marketRegistry: MarketRegistry
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let liquidator: Liquidator
    let usdc: TestERC20
    let weth: WETH9
    let wbtc: TestERC20
    let usdcDecimal: number

    beforeEach(async () => {
        // TODO setup Vault to be multi-collateral
        const _fixture = await loadFixture(createFixture())

        usdc = _fixture.USDC
        usdcDecimal = await usdc.decimals()
        weth = _fixture.WETH
        wbtc = _fixture.WBTC
        vault = _fixture.vault
        clearingHouse = _fixture.clearingHouse
        exchange = _fixture.exchange
        baseToken = _fixture.baseToken
        mockedBaseAggregator = _fixture.mockedBaseAggregator
        marketRegistry = _fixture.marketRegistry
        pool = _fixture.pool
        liquidator = _fixture.liquidator
    })

    describe("getMaxProfitableCollateral", () => {
        async function aliceLoseTrade() {
            // alice long 100 USDC worth of ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob short
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        }

        const nullAddress = "0x0000000000000000000000000000000000000000"

        beforeEach(async () => {
            // initialize ETH pool
            await pool.initialize(encodePriceSqrt("151.3733069", "1"))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await marketRegistry.addPool(baseToken.address, 10000)

            // set MaxTickCrossedWithinBlock to enable price checking before/after swap
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 100)

            const collateralDecimals = await usdc.decimals()

            const million = parseUnits("1000000", collateralDecimals)
            const hundred = parseUnits("100", collateralDecimals)

            // mint
            await usdc.mint(alice.address, hundred) // test subject
            await usdc.mint(bob.address, million) // helper
            await usdc.mint(carol.address, million) // maker

            await deposit(bob, vault, 1000000, usdc)
            await deposit(carol, vault, 1000000, usdc)

            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("15000"),
                lowerTick: 49000,
                upperTick: 51400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            await syncIndexToMarketPrice(mockedBaseAggregator, pool)
        })

        describe("no collaterals", () => {
            it("get the correct collateral", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })
        })

        describe.only("deposit only settlement token", () => {
            beforeEach(async () => {
                await deposit(alice, vault, 100, usdc)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await aliceLoseTrade()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })
        })

        describe("deposit only one non-settlement token", () => {
            beforeEach(async () => {
                // TODO need to add eth as collateral in fixture
                await deposit(alice, vault, 1, weth)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await aliceLoseTrade()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(weth.address)
            })
        })

        describe("deposit only multiple non-settlement tokens", () => {
            beforeEach(async () => {
                // TODO need to add eth as collateral in fixture
                await deposit(alice, vault, 1, weth)
                await deposit(alice, vault, 1, wbtc)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await aliceLoseTrade()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(wbtc.address)
            })
        })
    })

    describe("flashLiquidate", () => {
        it("profit on single-hop swap", async () => {})

        it("profit on multi-hop swap", async () => {})

        it("force trade on non-profitable single-hop swap", async () => {})

        it("force trade on non-profitable multi-hop swap", async () => {})

        it("force error, abort on non-profitable single-hop swap", async () => {})

        it("force error, abort on non-profitable multi-hop swap", async () => {})
    })

    describe("withdraw", () => {
        it("transfer specified token to owner", async () => {
            const balanceBefore = await usdc.balanceOf(admin.address)
            usdc.mint(liquidator.address, parseUnits("100", usdcDecimal))
            await liquidator.withdraw(usdc.address)
            const balanceAfter = await usdc.balanceOf(admin.address)

            expect(balanceAfter.sub(balanceBefore)).to.eq(parseUnits("100", usdcDecimal))
        })

        it("forced error, called by non-owner", async () => {
            await expect(liquidator.connect(alice).withdraw(usdc.address)).revertedWith(
                "Ownable: caller is not the owner",
            )
        })
    })
})
