import axios from "axios";

export const getAccounts = async (): Promise<string[]> => {
    try {
        const traderResult = await axios.post(
            '', {
                query: `Trader{
                    id
                }`
            }
        );
        const makerResult = await axios.post(
            '', {
                query: `Maker{
                    id
                }`
            }         
        )
        let traderList: string[] = []
        let makerList: string[] = []
        for(let i = 0; i < traderResult.data.data.Trader.length; i++){
            traderList.push(traderResult.data.data.Trader[i].id)
        }
        for(let i = 0; i < makerResult.data.data.Maker.length; i++){
            makerList.push(traderResult.data.data.Maker[i].id)
        }
        let accounts: string[] = []
        accounts.concat(traderList)
        for(let i = 0; i < makerList.length; i++){
            if(!accounts.includes(makerList[i])){
                accounts.push(makerList[i])
            }
        }
        return accounts        
    } catch (error) {
        console.error(error)
        return [""]
    }
    
}