/* eslint-disable @typescript-eslint/naming-convention */
import {
    Web3Function,
    Web3FunctionContext,
} from "@gelatonetwork/web3-functions-sdk";

import { Contract, providers, utils } from "ethers";

import { getAccounts } from "./theGraph";

// import { uploadJsonFile } from "./s3-cient";
import { liquidatorAbi, vaultAbi } from "./abis/abis";

interface ISTORED_DATA {
  accounts: string[];
  lastCoveredBlock: number;
}

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { multiChainProvider, storage } = context;
  const provider = multiChainProvider.default();

  const accounts = await getAccounts();

  const callDatas: Array<{ to: string; data: string }> = [];

  const vaultContract = new Contract(
    "0xvaultaddresshere",
    vaultAbi,
    provider
  ) as Contract;

  const liquidatorContract = new Contract(
    "0xliquidatoraddresshere",
    liquidatorAbi,
    provider
  ) as Contract;

  for (let i = 0; i < accounts.length; i += 1) {
    let isLiquidatable = await vaultContract.isLiquidatable(accounts[i])
    if(isLiquidatable){
      
    }
    const result = await helperContract.getInfo(slice, comptroller, bamms1);

    if (result.length > 0) {
      console.log("found liquidation candidate", result[0]);
      const iface = new utils.Interface(bammsAbi);

      callDatas.push({
        to: result[0].bamm,
        data: iface.encodeFunctionData("liquidateBorrow", [
          result[0].account,
          result[0].repayAmount,
          result[0].ctoken,
        ]),
      });
    }
  }

  if (callDatas.length > 0) {
    return {
      canExec: false,
      message: `Found ${callDatas.length} users to liquidate`,
    };
  }

  return { canExec: false, message: "No Users to liquidate" };
});

export async function updateUsers(
  provider: providers.StaticJsonRpcProvider,
  storedData: ISTORED_DATA
): Promise<ISTORED_DATA> {
  console.log("updating users");
  const currBlock = (await provider.getBlock("latest")).number - 10;
  if (currBlock > storedData.lastCoveredBlock) {
    storedData = await readAllUsers(
      storedData.lastCoveredBlock,
      currBlock,
      storedData,
      provider
    );
  }

  storedData.lastCoveredBlock = currBlock;

  console.log("updateUsers end");

  return storedData;
  //setTimeout(updateUsers, 1000 * 60);
}

async function readAllUsers(
  startBlock: number,
  lastBlock: number,
  storedData: ISTORED_DATA,
  provider: providers.StaticJsonRpcProvider
): Promise<ISTORED_DATA> {
  const step = 1000;
  const unitroller = "0x0F390559F258eB8591C8e31Cf0905E97cf36ACE2";
  const unitrollerIface = new utils.Interface(unitrollerABI);
  const topics = [unitrollerIface.getEventTopic("MarketEntered")];

  for (let i = startBlock; i < lastBlock; i += step) {
    const start = i;
    let end = i + step - 1;
    if (end > lastBlock) end = lastBlock;
    const eventFilter = {
      address: unitroller,
      topics,
      fromBlock: start,
      toBlock: end,
    };
    console.log("blocks: " + eventFilter.fromBlock, eventFilter.toBlock);
    const transferLogs = await provider.getLogs(eventFilter);

    for (const transferLog of transferLogs) {
      const transferEvent = unitrollerIface.parseLog(transferLog);
      const [, account] = transferEvent.args;
      if (!storedData.accounts.includes(account))
        storedData.accounts.push(account);
    }
  }

  console.log("num users", storedData.accounts.length);

  return storedData;
}