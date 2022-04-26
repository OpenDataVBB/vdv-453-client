'use strict'

import {strictEqual, ok} from 'assert'
import * as _router from 'router'
const {default: createRouter} = _router
import * as _onHeaders from 'on-headers'
const {default: onHeaders} = _onHeaders
import {parse as parseContentType} from 'content-type'
import {u} from 'unist-builder'
import {x} from 'xastscript'
import {SERVICES} from './services.js'
import {SERVER_CALLS} from './calls.js'
import {formatUnixTimestampAsIso8601} from './format-iso-8601-timestamp.js'
import {encodeXastTree} from './encode-xast-tree.js'
import {createXmlParser} from './xml-parser.js'
import {
	createAsyncIterableWithPush as asyncItWithPush,
} from './async-iterable-with-push.js'

// service + ':' + call -> response body's root elements
const CLIENT_RESPONSE_ROOT_ELS_BY_PATH = new Map([
	[SERVICES.REF_DFI + ':' + SERVER_CALLS.CLIENT_STATUS, 'ClientStatusAntwort'],
	[SERVICES.REF_DFI + ':' + SERVER_CALLS.DATEN_BEREIT, 'DatenBereitAntwort'],
	// todo: DFI
	// todo: ANS & ANS_REF
	// todo: VIS
	// todo: AND
	// todo: AUS & AUS_REF?
])

class ServerError extends Error {
	constructor (statusCode, statusMessage, req) {
		super(`${req.method} ${req.url}: ${statusMessage}`)
		// this.httpRequest = req
		this.responseStatusCode = statusCode
		this.responseStatusMessage = statusMessage
		return this
	}
}

const createServer = (cfg, opt = {}) => {
	const {
		logger,
		leitstelle,
	} = cfg
	ok('object' === typeof logger && logger, 'cfg.logger must be an object')
	strictEqual(typeof leitstelle, 'string', 'cfg.leitstelle must be a string')
	ok(leitstelle, 'cfg.leitstelle must not be empty')

	const router = createRouter({
		strict: true,
		caseSensitive: true,
	})

	// todo: add `compression` middleware

	const route = '/:leitstelle/:service/:call'

	router.use(route, (req, res, next) => {
		logger.debug({
			method: req.method,
			url: req.url,
			headers: req.rawHeaders,
		}, 'received request')

		// todo: check req protocol?
		// todo: do the server requests have auth?

		// > 5.2 Http-Bindung -> 5.2.1 Verfahren
		// > Der Nachrichtenaustausch über HTTP oder HTTPS erfolgt über die Methode POST.
		if (req.method !== 'POST') {
			next(new ServerError(405, 'POST only', req))
			return;
		}

		// > 5.2 Http-Bindung -> 5.2.1 Verfahren
		// > Beispiel HTTP-POST:
		// > POST /leitsystem1/ans/status.xml HTTP/1.1
		// > …
		// > Content-Type: text/xml
		// > …
		// > HTTP/1.1 200 OK
		// > Content-Type: text/xml Charset="utf-8"
		// (note the invalid Content-Type header format 🙄)
		if (!req.headers['content-type']) {
			next(new ServerError(400, 'missing Content-Type header', req))
			return;
		}
		const cType = parseContentType(req.headers['content-type'])
		if (cType.type !== 'text/xml') {
			next(new ServerError(400, `invalid content type "${cType.type}"`, req))
			return;
		}
		// > 5.2 Http-Bindung -> 5.2.2 Zeichensatz
		// > Es wird ausschließlich der Zeichensatz UTF-8 verwendet.
		const charset = cType.parameters.Charset || cType.parameters.charset || null
		if (charset && charset.toLowerCase() !== 'utf-8') {
			next(new ServerError(400, `invalid content type "${charset}"`, req))
			return;
		}

		// todo: use `boom` package for errors?
		if (req.params.leitstelle !== leitstelle) {
			next(new ServerError(404, 'wrong leitstelle', req))
			return;
		}
		if (!SERVICES.includes(req.params.service)) {
			next(new ServerError(404, 'unsupported service', req))
			return;
		}
		if (!SERVER_CALLS.includes(req.params.call)) {
			next(new ServerError(404, 'unsupported call', req))
			return;
		}

		const sig = req.params.service + ':' + req.params.call
		if (!CLIENT_RESPONSE_ROOT_ELS_BY_PATH.has(sig)) {
			next(new ServerError(404, 'unknown service or call', req))
			return;
		}
		const resRootTag = CLIENT_RESPONSE_ROOT_ELS_BY_PATH.get(sig)

		// todo: trace-log request body if it is small enough

		onHeaders(res, () => {
			logger.debug({
				statusCode: res.statusCode,
				statusMessage: res.statusMessage,
				headers: res.getHeaders(),
				// todo: timing
			}, 'sending response')
		})

		const respondWithXastTree = (bodyAsXastTree) => {
			// https://github.com/syntax-tree/xast-util-to-xml/blob/8d950a2b76348270d2d1551b3312ebca2a3a9d57/readme.md#use
			const tree = u('root', [
				u('instruction', {name: 'xml'}, 'version="1.0" encoding="utf-8"'),
				u('text', '\n'),
				bodyAsXastTree,
			])
			const body = encodeXastTree(tree)

			res.setHeader('content-type', 'text/xml; charset="utf-8"')
			res.setHeader('connection', 'keep-alive')

			// todo: trace-log response body if it is small enough
			res.end(body)
		}
		res.respondWithTree = respondWithXastTree

		const respondWithResponse = (_) => {
			const {
				ok: _ok,
				message,
				bestaetigung,
				status,
				retry,
				children,
			} = {
				ok: true,
				message: 'Ok',
				bestaetigung: true,
				status: false,
				retry: false,
				children: [],
				..._,
			}
			strictEqual(typeof _ok, 'boolean', 'ok must be a boolean')
			strictEqual(typeof message, 'string', 'message must be a string')
			ok(message, 'message must not be empty')
			strictEqual(typeof retry, 'boolean', 'retry must be a boolean')
			ok(Array.isArray(children), 'children must be an array')

			const statusCode = 'statusCode' in _
				? _.statusCode
				: (_ok ? 200 : (retry ? 500 : 400))
			strictEqual(typeof statusCode, 'number', 'statusCode must be a number')

			// > 6.1.10 Fehler in der fachlichen Schicht
			// > 0 – OK: (kein Fehler)
			// > 300-399 – übrige Fehler
			// > Alle anderen Fehler, die auf fehlerhafte Anfragen zurückgehen, werden in dieser Kategorie gemeldet.
			// > Die Anfrage sollte daher nicht identisch wiederholt werden
			// > 400-499 – übrige Antworten
			// > Fehlermeldungen, die aus anderen Gründen als einer fehlerhaften Anfrage resultieren, z.B. daraus, dass die angefragten Daten zurzeit bearbeitet werden oder temporär keinen Zugriff erlauben.
			// > Eine spätere Wiederholung der Anfrage kann zum Erfolg führen.
			const fehlernummer = 'fehlernummer' in _
				? _.fehlernummer
				: (_ok ? 0 : (retry ? 400 : 300))
			strictEqual(typeof fehlernummer, 'number', 'fehlernummer must be a number')

			const tree = x(resRootTag, {}, [
				bestaetigung ? x('Bestaetigung', {
					Ergebnis: _ok ? 'ok' : 'notok',
					Fehlernummer: fehlernummer + '',
					// todo: use Zst from req?
					Zst: formatUnixTimestampAsIso8601(Date.now()),
				}) : null,
				status ? x('Status', {
					Ergebnis: _ok ? 'ok' : 'notok',
					// todo: use Zst from req?
					Zst: formatUnixTimestampAsIso8601(Date.now()),
				}) : null,
				_ok ? null : x('Fehlertext', {}, [
					u('text', message),
				]),
				...children,
			])

			res.statusCode = statusCode
			res.statusMessage = message
			res.respondWithTree(tree)
		}
		res.respondWithResponse = respondWithResponse

		const parseTags = (tagsToParse) => {
			const {
				asyncIterable: parsed,
				push,
				fail,
				done,
			} = asyncItWithPush()

			// todo: stop parsing if `parsed` is not being iterated anymore
			const parser = createXmlParser(req)
			parser.once('error', fail)
			parser.once('end', done)

			tagsToParse.forEach(({tag, preserve}, i) => {
				strictEqual(typeof tag, 'string', `tagsToParse[${i}].tag must be a string`)
				ok(tag, `tagsToParse[${i}].tag must not be empty`)
				strictEqual(typeof preserve, 'boolean', `tagsToParse[${i}].preserve must be a boolean`)

				parser.collect(tag)
				if (preserve) parser.preserve(tag)

				// todo: try/catch?
				parser.on('endElement: ' + tag, el => push([tag, el]))
			})

			return parsed
		}
		req.parseTags = parseTags

		const parseWholeRoot = (rootTag, preserve = false) => {
			return new Promise((resolve, reject) => {
				// todo: stop parsing if `parsed` is not being iterated anymore
				const parser = createXmlParser(req)
				parser.once('error', reject)

				parser.collect(rootTag)
				if (preserve) parser.preserve(rootTag)

				parser.on('endElement: ' + rootTag, resolve)
				parser.once('end', () => {
					reject(new ServerError(400, `no "${rootTag}" root element`, req))
				})
			})
		}
		req.parseWholeRoot = parseWholeRoot

		next()
	})

	const errorHandler = (err, req, res, next) => {
		let logLevel = 'error'
		let statusCode = 500
		let msg = err.message || (err + '').split('\n')[0]
		if (err instanceof ServerError) {
			logLevel = 'warn'
			statusCode = err.responseStatusCode
			msg = err.responseStatusMessage
		}

		logger[logLevel]({
			error: err,
			serverRequest: req,
			clientResponse: res,
		}, msg)
		if (!res.headersSent) {
			res.statusCode = statusCode
			res.statusMessage = msg
			// todo: send proper XML error message
			res.end()
		}

		if (!(err instanceof ServerError)) {
			next(err)
		}
	}

	return {
		router,
		errorHandler,
	}
}

export {
	createServer,
}
