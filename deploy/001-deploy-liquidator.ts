import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import mainMetadataOptimismKovan from "../src/optimism-kovan.json"
import mainMetadataOptimism from "../src/optimism.json"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy } = deployments

    const { deployer } = await getNamedAccounts()
    const metadata = +process.env.NETWORK === 10 ? mainMetadataOptimism : mainMetadataOptimismKovan

    await deploy("Liquidator", {
        from: deployer,
        args: [metadata.contracts.Vault.address, metadata.externalContracts.UniswapV3SwapRouter],
        log: true,
        autoMine: true, // speed up deployment on local network (ganache, hardhat), no effect on live networks
    })
}
export default func
