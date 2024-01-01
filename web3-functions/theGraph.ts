import axios from "axios";

export const getAccounts = async () => {
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
        return result.data.data.accounts        
    } catch (error) {
        console.error(error)
    }
    
}