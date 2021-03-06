import { Wallet } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { Vault } from "../../typechain/perp-curie"
import { TestERC20 } from "../../typechain/test"
import { Fixture } from "../fixtures"

export async function deposit(sender: Wallet, vault: Vault, amount: number, token: TestERC20): Promise<void> {
    const decimals = await token.decimals()
    const parsedAmount = parseUnits(amount.toString(), decimals)
    await token.connect(sender).approve(vault.address, parsedAmount)
    await vault.connect(sender).deposit(token.address, parsedAmount)
}

export async function mintAndDeposit(
    fixture: Fixture,
    wallet: Wallet,
    amount: number,
    token: TestERC20,
): Promise<void> {
    const decimals = await token.decimals()
    const parsedAmount = parseUnits(amount.toString(), decimals)
    await token.mint(wallet.address, parsedAmount)
    await token.connect(wallet).approve(fixture.vault.address, parsedAmount)
    await deposit(wallet, fixture.vault, amount, token)
}
