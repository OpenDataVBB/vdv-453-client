'use strict'

import {ok} from 'node:assert'
import {createServer as createHttpServer} from 'http'
import {x} from 'xastscript'
import {u} from 'unist-builder'
import {CLIENT_CALLS, SERVER_CALLS, ALL_CALLS} from './lib/calls.js'
import {createSendRequest} from './lib/send-request.js'
import {createServer} from './lib/server.js'
import {SERVICES} from './lib/services.js'
import {formatUnixTimestampAsIso8601} from './lib/format-iso-8601-timestamp.js'

const {
	REF_DFI,
} = SERVICES
const {
	CLIENT_STATUS,
} = SERVER_CALLS

// This implementation follows the VDV 453 spec, as documented in the "VDV-453 Ist-Daten-Schnittstelle – Version 3.0" document.
// https://web.archive.org/web/20220411145248/https://www.vdv.de/service/downloads_onp.aspx?id=4337&forced=False
// see also https://web.archive.org/web/20220411144928/https://www.vdv.de/i-d-s-downloads.aspx

const createClient = (cfg, opt = {}) => {
	const sendRequest = createSendRequest(cfg, opt)
	const {router, errorHandler} = createServer(cfg, opt)

	router.post(`/:leitstelle/${REF_DFI}/${CLIENT_STATUS}`, (req, res, next) => {
		req.parseWholeRoot('ClientStatusAnfrage')
		.then((clientStatusAnfrage) => {
			console.error(clientStatusAnfrage)
			res.end('post!!')
		})
		.catch(next)
	})

	router.use(errorHandler)

	const httpServer = createHttpServer((req, res) => {
		const final = () => {
			// The `createServer()` should always have responded already, on both failures and successful handling.
			ok(res.headersSent, `router did not handle the request (${req.method} ${req.url})`)
		}
		router(req, res, final)
	})
	return {
		sendRequest,
		httpServer,
	}
}

export {
	SERVICES,
	CLIENT_CALLS, SERVER_CALLS, ALL_CALLS,
	createClient,
}
