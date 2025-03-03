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
import {Readable} from 'node:stream'
import _contentType from 'content-type'
const {parse: parseContentType} = _contentType
import {encodeXastTree} from './encode-xast-tree.js'
import {getZst} from './zst.js'
import {parseTags} from './xml-parser.js'

const BESTAETIGUNG = 'Bestaetigung'

const LOGGING_MAX_BODY_SIZE = 10 * 1024 // 10kb

// We losely mimick Ky here.
// https://github.com/sindresorhus/ky/blob/v1.2.2/source/errors/HTTPError.ts#L4-L22
class Vdv453HttpError extends Error {
	constructor(service, call, msg, req, reqOpts, reqBody, res, resBody = null) {
		super(msg)
		this.service = service
		this.call = call
		this.statusCode = res.statusCode
		this.statusMessage = res.statusMessage
		this.requestBody = reqBody || null
		this.responseBody = resBody || null
		Object.defineProperty(this, 'requestOpts', {value: reqOpts, configurable: true, writable: true})
		Object.defineProperty(this, 'request', {value: req, configurable: true, writable: true})
		Object.defineProperty(this, 'response', {value: res, configurable: true, writable: true})
	}
}

class Vdv453ApiError extends Error {
	constructor(service, call, fehlertext, fehlernummer, req, reqOpts, reqBody, res, resBody = null) {
		super(`${fehlertext} (${fehlernummer})`)
		this.service = service
		this.call = call
		this.service = service
		this.requestBody = reqBody || null
		this.responseBody = resBody || null
		Object.defineProperty(this, 'requestOpts', {value: reqOpts, configurable: true, writable: true})
		Object.defineProperty(this, 'request', {value: req, configurable: true, writable: true})
		Object.defineProperty(this, 'response', {value: res, configurable: true, writable: true})
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
		httpRequestTimeout,
		httpRequestOptions,
		httpKeepAlive,
		httpKeepAliveMsecs,
	} = {
		// This is a timeout for the total time until a response is received, *not* for the underlying socket.
		httpRequestTimeout: 30_000, // 30s
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

	const sendRequest = async (service, call, rootTag, rootChildren, opt = {}) => {
		const {
			abortController,
		} = {
			abortController: new AbortController(),
			...opt,
		}

		const reqId = randomBytes(6).toString('hex')
		const logCtx = {
			reqId,
			rootTag,
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
			signal: abortController.signal,
		}
		logCtx.requestOpts = reqOpts
		logger.debug(logCtx, 'sending request')

		const bodyAsTree = x(rootTag, {
			Sender: leitstelle,
			Zst: getZst(),
		}, rootChildren)
		const reqBody = encodeXastTree(bodyAsTree)
		logger.trace({
			reqId,
			body: reqBody.length > LOGGING_MAX_BODY_SIZE ? reqBody.slice(0, LOGGING_MAX_BODY_SIZE) : reqBody,
		}, (reqBody.length > LOGGING_MAX_BODY_SIZE ? 'truncated ' : '') + 'request body')

		let abortTimer = null
		if (httpRequestTimeout !== null) {
			abortTimer = setTimeout(() => {
				// todo: make sure this message appears in the error thrown by `request()`
				abortController.abort(`request timed out after ${httpRequestTimeout}ms`)
			}, httpRequestTimeout)
		}

		const request = isHttps ? httpsRequest : httpRequest
		const req = request(url, reqOpts)

		const res = await new Promise((resolve, reject) => {
			const onError = (err) => {
				reject(err)
				clearTimeout(abortTimer)

				logger.warn({
					...logCtx,
					err,
				}, `failed to send client request: ${err.message}`)
				req.destroy(err)
			}

			// todo: is this necessary for req/res to be GCed?
			const cleanUpAndResolve = (response) => {
				req.removeListener('error', onError)
				req.removeListener('response', cleanUpAndResolve)
				resolve(response)
			}
			req.on('error', onError)
			req.on('response', cleanUpAndResolve)

			req.end(reqBody) // send request body
		})
		clearTimeout(abortTimer)
		logCtx.statusCode = res.statusCode
		logCtx.statusMessage = res.statusMessage
		logCtx.headers = res.headers
		logger.debug({
			...logCtx,
			// todo: timing
		}, 'received response')

		const hasBody = res.headers['content-length']
			? parseInt(res.headers['content-length']) > 0
			: true // fall back to assuming there's a body
		let resBody = res
		// Sometimes, the HTTP load balancer responds with a 503 without any body and Content-Type.
		if (hasBody) {
			// todo: as a fallback, implicitly assume text/xml & ISO-8559-1 even if no charset is specified?
			ok(res.headers['content-type'], 'response must have a "Content-Type" header')
			const {
				type: _resCType,
				parameters: {
					charset: _resCharset = null,
				},
			} = parseContentType(res.headers['content-type'])

			if (_resCharset !== null) {
				// wrap into a Web Stream first, to be able to pipe into TextDecodeStream
				resBody = Readable.toWeb(resBody)

				const decoder = new TextDecoderStream(_resCharset)
				resBody.pipeTo(decoder.writable)
				resBody = decoder.readable
			}
		}

		if (res.statusCode < 200 || res.statusCode >= 300) {
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
				let _resBody = ''
				for await (const chunk of resBody) {
					_resBody += chunk // todo: response charset?
				}

				// We assume the body contains the error message.
				const msg = 'VDV Server: ' + (_resBody.trim() || res.statusMessage)
				err = new Vdv453HttpError(
					service,
					call,
					msg,
					req,
					reqOpts,
					reqBody,
					res,
					_resBody,
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

		// todo: trace-log response body if it is small enough

		const parseResponse = (tagsToParse) => {
			return parseTags(resBody, tagsToParse)
		}

		const assertStatusAntwortOk = (statusAntwort, addLogLabels = {}) => {
			// todo: make err.message more helpful, e.g. by building a custom error
			try {
				strictEqual(statusAntwort.Status.$.Ergebnis, 'ok', 'response: status.$.Ergebnis must be correct')
			} catch (err) {
				logger.warn({
					...logCtx,
					...addLogLabels,
					err,
				}, err.message)
				Object.assign(err, logCtx)
				err.statusAntwort = statusAntwort
				throw err
			}
		}

		const assertBestaetigungOk = (bestaetigung) => {
			if (bestaetigung.$.Ergebnis === 'ok') {
				return;
			}

			const fehlertext = bestaetigung.Fehlertext?.$text || null
			const fehlernummer = bestaetigung.$.Fehlernummer
				? parseInt(bestaetigung.$.Fehlernummer)
				: null

			const err = new Vdv453ApiError(
				service,
				call,
				fehlertext,
				fehlernummer,
				req,
				reqOpts,
				reqBody,
				res,
			)

			logger.warn({
				...logCtx,
				serverFehlernummer: fehlernummer,
				err,
			}, err.message)
			Object.assign(err, logCtx)
			err.bestaetigung = bestaetigung
			throw err
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
	Vdv453HttpError,
	Vdv453ApiError,
	createSendRequest,
}
