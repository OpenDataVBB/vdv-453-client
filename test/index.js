'use strict'

import {test} from 'tape'
import {runClient} from './util.js'

const LEITSTELLE = 'test-client'

test('todo', async (t) => {
	const {
		port,
		stop,
	} = await runClient({
		leitstelle: LEITSTELLE,
		endpoint: 'http://localhost:3000/',
	})

	// todo

	await stop()
})
