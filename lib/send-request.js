'use strict'

import {ok, strictEqual} from 'node:assert'
import {randomBytes} from 'node:crypto'
import {request} from 'node:https'
import {encodeXastTree} from './encode-xast-tree.js'
import {parseTags} from './xml-parser.js'

const BESTAETIGUNG = 'Bestaetigung'

const createSendRequest = (cfg, opt = {}) => {
	const {
		logger,
		endpoint,
	} = cfg
	ok('object' === typeof logger && logger, 'cfg.logger must be an object')
	strictEqual(typeof endpoint, 'string', 'cfg.endpoint must be a string')
	ok(endpoint, 'cfg.endpoint must not be empty')

	const {
		httpRequestOptions,
	} = {
		httpRequestOptions: {},
		...opt,
	}

	const sendRequest = async (service, call, bodyAsTree) => {
		const reqId = randomBytes(6).toString('hex')
		const logCtx = {
			reqId,
			clientRequest: undefined,
			serverResponse: undefined,
		}

		// todo: validate service & call?
		let url = new URL(endpoint)
		if (url.pathname.slice(-1) !== '/') url.pathname += '/'
		url.pathname += `${encodeURIComponent(service)}/${encodeURIComponent(call)}`
		url = url.href
		logCtx.url = url

		const reqOpts = {
			method: 'POST',
			headers: {
				'content-type': 'text/xml; charset="utf-8',
				'connection': 'keep-alive',
			},
			...httpRequestOptions,
		}
		logCtx.requestOpts = reqOpts
		logger.debug(logCtx, 'sending request')

		const body = encodeXastTree(bodyAsTree)
		// todo: check if it is small enough
		logger.trace({
			reqId,
			body,
		}, 'request body')

		const req = request(url, reqOpts)
		logCtx.clientRequest = req

		const res = await new Promise((resolve, reject) => {
			req.once('error', (err) => {
				reject(err)

				logger.warn({
					...logCtx,
					err,
				}, `failed to send client request: ${err.message}`)
				req.destroy(err) // todo: is this necessary?
			})
			req.once('respone', resolve)
		})
		logCtx.serverResponse = res
		logCtx.statusCode = res.statusCode
		logCtx.statusMessage = res.statusMessage
		logger.debug({
			...logCtx,
			// todo: timing
		}, 'received response')
		// todo: trace-log response body if it is small enough

		const parseResponse = (tagsToParse) => {
			return parseTags(res, tagsToParse)
		}

		const assertBestaetigungOk = (bestaetigung) => {
			if (bestaetigung.$.Fehlernummer) {
				const f = parseInt(bestaetigung.$.Fehlernummer)
				ok(Number.isInteger(f), 'bestaetigung.$.Fehlernummer must be an integer')
				logCtx.serverFehlernummer = f
			}

			try {
				strictEqual(bestaetigung.$.Ergebnis, 'ok', 'response: bestaetigung.$.Ergebnis must be correct')
			} catch (err) {
				logger.warn({...logCtx, err}, err.message)
				Object.assign(err, logCtx)
				err.bestaetigung = bestaetigung
				throw err
			}
		}

		return {
			clientRequest: req,
			serverResponse: res,
			parseResponse,
			assertBestaetigungOk,
		}
	}

	return sendRequest
}

export {
	BESTAETIGUNG,
	createSendRequest,
}
