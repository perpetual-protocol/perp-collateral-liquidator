import { waffle } from "hardhat"
import { createFixture } from "./fixtures"

describe("Liquidator", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    // let liquidator: Liquidator

    beforeEach(async () => {
        const _fixture = await loadFixture(createFixture())

        // liquidator = _fixture.liquidator
    })

    // TODO WIP
    it("test", () => {})
})
