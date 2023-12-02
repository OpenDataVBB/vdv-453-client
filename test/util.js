import pino from 'pino'
import {ok} from 'assert'
import getPort from 'get-port'
import {promisify} from 'util'
// import axios from 'axios'
import {createClient} from '../index.js'

const logger = pino({
	level: process.env.LOG_LEVEL || 'error',
})

const runClient = async (cfg) => {
	const {
		leitstelle,
		endpoint,
	} = cfg
	ok(leitstelle)
	ok(endpoint)

	const {
		httpServer,
	} = createClient({
		leitstelle,
		endpoint,
		logger,
	})

	const port = await getPort()
	await promisify(httpServer.listen.bind(httpServer))(port)

	const stop = () => promisify(httpServer.close.bind(httpServer))()
	// const fetch = (path, opt = {}) => {
	// 	opt = Object.assign({
	// 		method: 'get',
	// 		baseURL: `http://localhost:${port}/`,
	// 		url: path,
	// 		timeout: 5000
	// 	}, opt)
	// 	return axios(opt)
	// }
	return {
		port,
		stop,
		// fetch,
	}
}

export {
	runClient,
}
