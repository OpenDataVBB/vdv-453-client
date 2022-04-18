'use strict'

import {ok, strictEqual} from 'assert'
import {request} from 'http'
import {encodeXastTree} from './encode-xast-tree.js'
import {createXmlParser} from './xml-parser.js'

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
		const logCtx = {
			clientRequest: undefined,
			serverResponse: undefined,
		}

		// todo: validate service & call?
		let url = new URL(endpoint)
		if (url.pathname.slice(-1) !== '/') url.pathname += '/'
		url.pathname += `${encodeURIComponent(service)}/${encodeURIComponent(call)}`
		url = url.href

		const reqOpts = {
			method: 'POST',
			headers: {
				'content-type': 'text/xml; charset="utf-8',
				'connection': 'keep-alive',
			},
			...httpRequestOptions,
		}
		logger.debug({
			method: reqOpts.method,
			url,
			headers: reqOpts.headers,
		}, 'sending request')

		const body = encodeXastTree(bodyAsTree)
		// todo: check if it is small enough
		logger.trace({
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
				}, 'failed to send client request')
				req.destroy(err) // todo: is this necessary?
			})
			req.once('respone', resolve)
		})
		logger.debug({
			statusCode: res.statusCode,
			statusMessage: res.statusMessage,
			headers: res.headers,
			// todo: timing
		}, 'received response')
		logCtx.serverResponse = res
		// todo: trace-log response body if it is small enough

		const parseResponse = (tagsToParse) => {
			return createXmlParser(res, tagsToParse)
		}

		const assertBestaetigungOk = (bestaetigung) => {
			try {
				strictEqual(bestaetigung.$.Ergebnis, 'ok', 'response: bestaetigung.$.Ergebnis must be correct')
			} catch (err) {
				logger.warn({...logCtx, err}, err.message)
				err.clientRequest = req
				err.serverResponse = res
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
	createSendRequest,
}
