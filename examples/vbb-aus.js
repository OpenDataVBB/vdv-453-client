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

const {
	logger,
	httpServer,
	data,
	ausSubscribe,
	ausUnsubscribe,
} = createClient({
	leitstelle: LEITSTELLE,
	endpoint: ENDPOINT,
})

await promisify(httpServer.listen.bind(httpServer))(PORT)
logger.info(`listening on port ${PORT}`)

const expiresAt = process.env.AUS_EXPIRES_AT
	? parseInt(process.env.AUS_EXPIRES_AT) * 1000
	: Date.now() + 10 * 60 * 1000 // in 10 minutes
const fetchInterval = process.env.AUS_FETCH_INTERVAL
	? parseInt(process.env.AUS_FETCH_INTERVAL) * 1000
	: 30_000 // 30 seconds

const {aboId} = await ausSubscribe({
	expiresAt,
	fetchInterval,
})
process.on('SIGINT', () => {
	ausUnsubscribe(aboId)
	.then(() => {
		httpServer.close()
	})
	.catch(abortWithError)
})

data.on('aus:IstFahrt', (istFahrt) => {
	console.log(istFahrt)
})
