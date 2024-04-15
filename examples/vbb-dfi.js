import {promisify} from 'node:util'
import {createClient} from '../index.js'

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

if (!process.env.VDV_453_ANZEIGERBEREICH_ID) {
	abortWithError('missing/empty $VDV_453_ANZEIGERBEREICH_ID')
}
const ANZEIGERBEREICH_ID = process.env.VDV_453_ANZEIGERBEREICH_ID

const {
	logger,
	httpServer,
	data,
	dfiSubscribe,
	dfiUnsubscribe,
} = createClient({
	leitstelle: LEITSTELLE,
	endpoint: ENDPOINT,
})

await promisify(httpServer.listen.bind(httpServer))(PORT)
logger.info(`listening on port ${PORT}`)

const {aboId} = await dfiSubscribe(ANZEIGERBEREICH_ID, {
	expiresAt: Date.now() + 10 * 60 * 1000, // for 10min
})
process.on('SIGINT', () => {
	dfiUnsubscribe(aboId)
	.then(() => {
		httpServer.close()
	})
	.catch(abortWithError)
})

data.on('dfi:AZBNachricht', console.log)
