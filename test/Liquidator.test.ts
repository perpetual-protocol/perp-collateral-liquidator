import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { Liquidator } from "../typechain"
import { TestERC20 } from "../typechain/test"
import { createFixture } from "./fixtures"

describe("Liquidator", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()

    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])

    let liquidator: Liquidator
    let usdc: TestERC20
    let usdcDecimal: number

    beforeEach(async () => {
        const _fixture = await loadFixture(createFixture())

        usdc = _fixture.USDC
        usdcDecimal = await usdc.decimals()
        liquidator = _fixture.liquidator
    })

    describe("getMaxProfitableCollateral", () => {
        it("get the correct collateral out of none", async () => {})

        it("get the correct collateral out of one", async () => {})

        it("get the correct collateral out of many", async () => {})
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
