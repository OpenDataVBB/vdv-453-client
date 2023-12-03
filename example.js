'use strict'

import pino from 'pino'
import {promisify} from 'node:util'
import {createClient} from './index.js'

const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
})

const {
	httpServer,
} = createClient({
	leitstelle: 'vdv-453-client-example',
	endpoint: 'https://example.org/', // todo
	logger,
})

await promisify(httpServer.listen.bind(httpServer))(3000)
logger.info('listening on port 3000')
