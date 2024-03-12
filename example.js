'use strict'

import {promisify} from 'node:util'
import {createClient} from './index.js'

const abortWithError = (err) => {
	console.error(err)
	process.exit(1)
}

if (!process.env.VDV_453_LEITSTELLE) {
	abortWithError('missing/empty $VDV_453_LEITSTELLE')
}
const LEITSTELLE = process.env.VDV_453_LEITSTELLE
if (!process.env.VDV_453_ENDPOINT) {
	abortWithError('missing/empty $VDV_453_ENDPOINT')
}
const ENDPOINT = process.env.VDV_453_ENDPOINT
if (!process.env.PORT) {
	abortWithError('missing/empty $PORT')
}
const PORT = process.env.PORT

// if (!process.env.VDV_453_ANZEIGERBEREICH_ID) {
// 	abortWithError('missing/empty $VDV_453_ANZEIGERBEREICH_ID')
// }
// const ANZEIGERBEREICH_ID = process.env.VDV_453_ANZEIGERBEREICH_ID

const {
	logger,
	httpServer,
	// dfiSubscribe,
	// dfiData,
	// dfiUnsubscribe,
	// dfiUnsubscribeAll,
	ausSubscribe,
	ausData,
	ausUnsubscribe,
	ausUnsubscribeAll,
} = createClient({
	leitstelle: LEITSTELLE,
	endpoint: ENDPOINT,
})

await promisify(httpServer.listen.bind(httpServer))(PORT)
logger.info(`listening on port ${PORT}`)

// const {aboId} = await dfiSubscribe(ANZEIGERBEREICH_ID, {
const {aboId} = await ausSubscribe({
	expiresAt: Date.now() + 10 * 60 * 1000, // for 10min
	// todo: filter by ANZEIGERBEREICH_ID?
})

console.info('reading subscription items')
// for await (const d of dfiData.readable) {
for await (const d of ausData.readable) {
	console.log(d)
}

// await dfiUnsubscribe(aboId)
// await dfiUnsubscribeAll()
await ausUnsubscribe(aboId)
// await ausUnsubscribeAll()

httpServer.close()