'use strict'

import pino from 'pino'
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

httpServer.listen(3000, (err) => {
	if (err) {
		logger.error({
			error: err,
		}, err.message)
		process.exit(1)
	}

	logger.info('listening on port 3000')
})
