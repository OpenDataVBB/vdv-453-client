'use strict'

import pino from 'pino'
import {strictEqual, ok} from 'node:assert'
import {createServer as createHttpServer} from 'node:http'
import {x} from 'xastscript'
import {u} from 'unist-builder'
import {CLIENT_CALLS, SERVER_CALLS, ALL_CALLS} from './lib/calls.js'
import {createSendRequest, BESTAETIGUNG,} from './lib/send-request.js'
import {createServer} from './lib/server.js'
import {SERVICES} from './lib/services.js'
import {getZst} from './lib/zst.js'

const {
	DFI,
	// REF_DFI,
	// ANS,
	// REF_ANS,
	// VIS,
	// AND,
	// AUS,
	// REF_AUS,
} = SERVICES
const {
	STATUS,
} = CLIENT_CALLS
const {
	CLIENT_STATUS,
} = SERVER_CALLS

// This implementation follows the VDV 453 spec, as documented in the "VDV-453 Ist-Daten-Schnittstelle – Version 2.6.1" document. It also supports the VDV 454 extension, as documented in the "VDV-454 Ist-Daten-Schnittstelle – Fahrplanauskunft – Version 2.2.1".
// https://web.archive.org/web/20231208122259/https://www.vdv.de/vdv-schrift-453-v2.6.1-de.pdfx?forced=true
// https://web.archive.org/web/20231208122259/https://www.vdv.de/454v2.2.1-sd.pdfx?forced=true
// see also https://web.archive.org/web/20231208122259/https://www.vdv.de/i-d-s-downloads.aspx

const createClient = (cfg, opt = {}) => {
	const {
		leitstelle,
	} = cfg
	strictEqual(typeof leitstelle, 'string', 'cfg.leitstelle must be a string')
	ok(leitstelle, 'cfg.leitstelle must not be empty')

	const {
		logger,
	} = {
		logger: pino({
			level: process.env.LOG_LEVEL || 'info',
		}),
		...opt,
	}
	ok('object' === typeof logger && logger, 'opt.logger must be an object')
	cfg = {
		...cfg,
		logger,
	}

	const sendRequest = createSendRequest(cfg, opt)
	const {router, errorHandler} = createServer(cfg, opt)

	// ----------------------------------

	const startDienstZst = getZst()

	// todo: move to lib/server.js?
	const _onRequest = (service, call, handleRequest) => {
		const path = [leitstelle, service, call].map(part => encodeURIComponent(part))
		router.post('/' + path, async (req, res, next) => {
			try {
				await handleRequest(req, res, next)
			} catch (err) {
				next(err)
			}
		})
	}

	const _handleClientStatusAnfrage = (service) => {
		_onRequest(service, CLIENT_STATUS, async (req, res) => {
			const logCtx = {
				service,
			}

			const clientStatusAnfrage = await req.parseWholeRoot('ClientStatusAnfrage')
			logCtx.clientStatusAnfrage = clientStatusAnfrage
			logger.debug(logCtx, 'received ClientStatusAnfrage')

			// todo: expose value of `StartDienstZst` child?
			// todo: expose value of `DatenVersionID` child?

			res.respondWithResponse({
				ok: true, // todo: are we ever not okay?
				status: true, // send Status element
				children: [
					x('StartDienstZst', {}, startDienstZst),
					// todo: provide AktiveAbos if `clientStatusAnfrage.$.MitAbos` has value `true`
					// > 5.1.8.3 ClientStatusAnfrage
					// > Beispiel 3: Antwort des Clients: Dienst verfügbar, Client initialisiert gerade und will keine Auskunft zu den aktiven Abonnements geben:
				],
			})
		})
	}

	const _sendStatusAnfrage = async (service) => {
		const {
			parseResponse,
			assertStatusAntwortOk,
		} = await sendRequest(
			service,
			STATUS,
			// todo: move "StatusAnfrage" into constant?
			'StatusAnfrage',
			[],
		)

		const tags = parseResponse([
			// todo: move "StatusAntwort" into constant?
			{tag: 'StatusAntwort', preserve: true},
		])
		for await (const [tag, el] of tags) {
			if (tag === 'StatusAntwort') {
				assertStatusAntwortOk(el)

				logger.debug({
					service,
					statusAntwort: el,
				}, 'received StatusAntwort')
				return el
			}
		}
	}

	// ----------------------------------

	_handleClientStatusAnfrage(DFI)
	// _handleClientStatusAnfrage(REF_DFI)
	// _handleClientStatusAnfrage(ANS)
	// _handleClientStatusAnfrage(REF_ANS)
	// _handleClientStatusAnfrage(VIS)
	// _handleClientStatusAnfrage(AND)
	// _handleClientStatusAnfrage(AUS)
	// _handleClientStatusAnfrage(REF_AUS)

	// ----------------------------------

	router.use(errorHandler)

	const httpServer = createHttpServer((req, res) => {
		const final = () => {
			// The `createServer()` should always have responded already, on both failures and successful handling.
			ok(res.headersSent, `router did not handle the request (${req.method} ${req.url})`)
		}
		router(req, res, final)
	})
	return {
		logger,
		sendRequest,
		httpServer,
	}
}

export {
	SERVICES,
	CLIENT_CALLS, SERVER_CALLS, ALL_CALLS,
	createClient,
}
