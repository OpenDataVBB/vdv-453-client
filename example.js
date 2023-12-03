'use strict'

import {promisify} from 'node:util'
import {createClient} from './index.js'

const {
	logger,
	httpServer,
} = createClient({
	leitstelle: 'vdv-453-client-example',
	endpoint: 'https://example.org/', // todo
})

await promisify(httpServer.listen.bind(httpServer))(3000)
logger.info('listening on port 3000')
