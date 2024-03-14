'use strict'

import {ok, strictEqual} from 'node:assert'
import {randomBytes} from 'node:crypto'
import {x} from 'xastscript'
import {
	Agent as HttpsAgent,
	request as httpsRequest,
} from 'node:https'
import {
	Agent as HttpAgent,
	request as httpRequest,
} from 'node:http'
import {encodeXastTree} from './encode-xast-tree.js'
import {getZst} from './zst.js'
import {parseTags} from './xml-parser.js'

const BESTAETIGUNG = 'Bestaetigung'

// We losely mimick Ky here.
// https://github.com/sindresorhus/ky/blob/v1.2.2/source/errors/HTTPError.ts#L4-L22
class Vdv453HttpError extends Error {
	constructor(service, call, msg, req, reqOpts, reqBody, res, resBody = null) {
		super(msg)
		this.service = service
		this.call = call
		this.statusCode = res.statusCode
		this.statusMessage = res.statusMessage
		this.requestOpts = reqOpts
		this.requestBody = reqBody || null
		this.responseBody = resBody || null
		Object.defineProperty(this, 'request', {value: req})
		Object.defineProperty(this, 'response', {value: res})
	}
}

const createSendRequest = (cfg, opt = {}) => {
	const {
		logger,
		endpoint,
		leitstelle,
	} = cfg
	ok('object' === typeof logger && logger, 'cfg.logger must be an object')
	strictEqual(typeof endpoint, 'string', 'cfg.endpoint must be a string')
	ok(endpoint, 'cfg.endpoint must not be empty')
	strictEqual(typeof leitstelle, 'string', 'cfg.leitstelle must be a string')
	ok(leitstelle, 'cfg.leitstelle must not be empty')

	const {
		httpRequestOptions,
		httpKeepAlive,
		httpKeepAliveMsecs,
	} = {
		httpRequestOptions: {},
		httpKeepAlive: true,
		httpKeepAliveMsecs: 10_000, // 10s
		...opt,
	}

	const httpAgent = httpKeepAlive
		? new HttpAgent({
			keepAlive: httpKeepAlive,
			keepAliveMsecs: httpKeepAliveMsecs,
		})
		: null
	const httpsAgent = httpKeepAlive
		? new HttpsAgent({
			keepAlive: httpKeepAlive,
			keepAliveMsecs: httpKeepAliveMsecs,
		})
		: null

	const sendRequest = async (service, call, rootTag, rootChildren) => {
		const reqId = randomBytes(6).toString('hex')
		const logCtx = {
			reqId,
			rootTag,
			clientRequest: undefined,
			serverResponse: undefined,
		}

		// todo: validate service & call?
		let url = new URL(endpoint)
		if (url.pathname.slice(-1) !== '/') url.pathname += '/'
		url.pathname += `${encodeURIComponent(leitstelle)}/${encodeURIComponent(service)}/${encodeURIComponent(call)}`
		url = url.href
		logCtx.url = url

		const isHttps = new URL(url).protocol === 'https:'
		const reqOpts = {
			agent: isHttps ? httpsAgent : httpAgent,
			method: 'POST',
			headers: {
				// VDV-453 spec uses `text/xml` in its examples, not `application/xml`.
				'content-type': 'text/xml; charset="utf-8"',
				'connection': 'keep-alive',
			},
			...httpRequestOptions,
		}
		logCtx.requestOpts = reqOpts
		logger.debug(logCtx, 'sending request')

		const bodyAsTree = x(rootTag, {
			Sender: leitstelle,
			Zst: getZst(),
		}, rootChildren)
		const reqBody = encodeXastTree(bodyAsTree)
		// todo: check if it is small enough
		logger.trace({
			reqId,
			body: reqBody,
		}, 'request body')

		const request = isHttps ? httpsRequest : httpRequest
		const req = request(url, reqOpts)
		logCtx.clientRequest = req

		const res = await new Promise((resolve, reject) => {
			req.once('error', (err) => {
				reject(err)

				logger.warn({
					...logCtx,
					err,
				}, `failed to send client request: ${err.message}`)
				req.destroy(err)
			})
			req.once('response', resolve)

			req.end(reqBody) // send request body
		})
		logCtx.serverResponse = res
		logCtx.statusCode = res.statusCode
		logCtx.statusMessage = res.statusMessage
		logger.debug({
			...logCtx,
			// todo: timing
		}, 'received response')
		// todo: trace-log response body if it is small enough

		// todo: parse properly
		const _resCType = res.headers['content-type']
		if ((res.statusCode < 200 || res.statusCode >= 300) && _resCType === 'text/plain') {
			let err = new Vdv453HttpError(
				service,
				call,
				`request failed with "${res.statusCode} ${res.statusMessage}"`,
				req,
				reqOpts,
				reqBody,
				res,
			)
			try {
				let resBody = ''
				for await (const chunk of res) {
					resBody += chunk // todo: response charset?
				}

				// We assume the body contains the error message.
				const msg = 'VDV Server: ' + resBody
				err = new Vdv453HttpError(
					service,
					call,
					msg,
					req,
					reqOpts,
					reqBody,
					res,
					resBody,
				)
			} catch (obtainResBodyErr) {
				logger.warn({
					...logCtx,
					err: obtainResBodyErr,
				}, 'failed to obtain response body: ' + obtainResBodyErr.message)

				err.obtainResBodyErr = obtainResBodyErr
			}
			throw err
		}

		const parseResponse = (tagsToParse) => {
			return parseTags(res, tagsToParse)
		}

		const assertStatusAntwortOk = (statusAntwort) => {
			try {
				strictEqual(statusAntwort.Status.$.Ergebnis, 'ok', 'response: status.$.Ergebnis must be correct')
			} catch (err) {
				logger.warn({...logCtx, err}, err.message)
				Object.assign(err, logCtx)
				err.statusAntwort = statusAntwort
				throw err
			}
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
			assertStatusAntwortOk,
			assertBestaetigungOk,
		}
	}

	return sendRequest
}

export {
	BESTAETIGUNG,
	createSendRequest,
}
