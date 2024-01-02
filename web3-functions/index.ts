/* eslint-disable @typescript-eslint/naming-convention */
import {
    Web3Function,
    Web3FunctionContext,
} from "@gelatonetwork/web3-functions-sdk";

import { Contract, providers, utils } from "ethers";

import { getAccounts } from "./theGraph";

// import { uploadJsonFile } from "./s3-cient";
import { liquidatorAbi, vaultAbi } from "./abis/abis";
import { stableCoinList } from "./stableCoins";


Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { multiChainProvider, storage } = context;
  const provider = multiChainProvider.default();

  const accounts: string[] = await getAccounts();

  const liquidatorContract = new Contract(
    "0xliquidatoraddresshere",
    liquidatorAbi,
    provider
  ) as Contract;

  const vaultAddr = await liquidatorContract.getVault();
  const vaultContract = new Contract(
    vaultAddr,
    vaultAbi,
    provider
  ) as Contract;

  const clearingHouseAddr = await vaultContract.getClearingHouse();
  const clearingHouseContract = new Contract(
    clearingHouseAddr,
    vaultAbi,
    provider
  ) as Contract;

  const uniswapV3Factory = new Contract(
    "0xuniswapv3address",
    vaultAbi,
    provider
  ) as Contract;

  const quoteToken = await clearingHouseContract.getQuoteToken();

  for (let i = 0; i < accounts.length; i += 1) {
    let isLiquidatable = await vaultContract.isLiquidatable(accounts[i])
    if(isLiquidatable){
      let collateral = await liquidatorContract.getMaxProfitableCollateral(accounts[i]);
      let [settlement, ] = await vaultContract.getMaxRepaidSettlementAndLiquidatableCollateral(accounts[i], collateral);
      if(stableCoinList.includes(collateral)){
        let [curveFactory, curvePool] = await liquidatorContract.findCurveFactoryAndPoolForCoins(collateral, quoteToken)
        const uniPool = await uniswapV3Factory.getPool(collateral, quoteToken, "10000")
        await liquidatorContract.flashLiquidateThroughCurve(
          {    
            trader: accounts[i],
            maxSettlementTokenSpent: settlement.toString(),
            minSettlementTokenProfit: "0",
            uniPool: uniPool,
            crvFactory: curveFactory,
            crvPool: curvePool,
            token: collateral,
          }
        )
      } else {
        await liquidatorContract.flashLiquidate(
          accounts[i],
          settlement.toString(),
          "0",
          { tokenIn: collateral, fee: "10000", tokenOut: quoteToken },
          "0x"
        )
      }    
    }
  }    

  if (accounts.length > 0) {
    return {
      canExec: false,
      message: `Found ${accounts.length} accounts to liquidate`,
    };
  }

  return { canExec: false, message: "No Users to liquidate" };
});
