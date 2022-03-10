import { Liquidator } from "./liquidator"

async function main(): Promise<void> {
    // crash fast on uncaught errors
    const exitUncaughtError = async (err: any): Promise<void> => {
        console.error({
            event: "UncaughtException",
            params: {
                err,
            },
        })
        process.exit(1)
    }
    process.on("uncaughtException", err => exitUncaughtError(err))
    process.on("unhandledRejection", reason => exitUncaughtError(reason))

    const liquidator = new Liquidator()
    await liquidator.setup()
    await liquidator.start()
}

if (require.main === module) {
    main()
}
